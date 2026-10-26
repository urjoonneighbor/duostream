// DuoStream Capture — собственный захват экрана или окна для DuoStream.
//
// Зачем: на Windows 11 24H2+ Windows Graphics Capture по умолчанию отдаёт кадр не чаще раза в 16 мс
// (MinUpdateInterval), а Chromium это значение не меняет — встроенный захват упирается в ~60 FPS.
// Здесь WGC работает с MinUpdateInterval = 1 мс, кадр копируется на GPU в одну из общих
// D3D11-текстур, а её NT-хэндл заранее продублирован в процесс Electron. Electron импортирует
// текстуру через sharedTexture и отдаёт её в WebRTC как VideoFrame — без копирования в RAM.
//
// Аргументы: --parent <pid Electron> --fps <N> (--window <HWND> | --point <x>,<y>)
//            [--gpu <vendorId>:<deviceId>] [--ring <число текстур>]
//
// stdout, строки JSON:
//   {"type":"ready","gen":G,"width":W,"height":H,"handles":["…"],"adapter":"…"} — новое кольцо текстур W×H
//   {"type":"frame","gen":G,"i":слот,"ts":мкс,"w":ширина кадра,"h":высота кадра} — новый кадр или
//                  повтор последнего, если источник не менялся 100 мс
//   {"type":"stats","fps":…,"dropped":…,"copyMs":…}                       — раз в 2 с
//   {"type":"closed"} — источник закрыт;  {"type":"error","message":"…"} — фатальная ошибка
// stdin:
//   "gen G"        — Electron перешёл на кольцо G, старые хэндлы в его процессе можно закрыть
//   "free G i"     — Electron и WebRTC больше не используют текстуру i кольца G
//   конец потока   — завершение работы
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

[ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
}

[StructLayout(LayoutKind.Sequential)]
struct Texture2DDesc { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }

[StructLayout(LayoutKind.Sequential)]
struct Box { public uint Left, Top, Front, Right, Bottom, Back; }

[StructLayout(LayoutKind.Sequential)]
struct MonitorInfo { public int Size; public int Left, Top, Right, Bottom; public int WorkLeft, WorkTop, WorkRight, WorkBottom; public int Flags; }

/// <summary>Кольцо общих текстур одного размера («поколение»).</summary>
sealed class Ring
{
    public int Gen;
    public int Width, Height;
    public IntPtr[] Textures;
    public long[] RemoteHandles;
    public ConcurrentQueue<int> Free;
}

static unsafe class Program
{
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint numLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(long point, uint flags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr srcProcess, IntPtr src, IntPtr dstProcess, out IntPtr dst, uint access, bool inherit, uint options);

    const uint DXGI_FORMAT_B8G8R8A8_UNORM = 87;
    const uint BIND_SHADER_RESOURCE = 0x8, BIND_RENDER_TARGET = 0x20;
    const uint MISC_SHARED = 0x2, MISC_SHARED_NTHANDLE = 0x800;
    const uint DUPLICATE_CLOSE_SOURCE = 1, DUPLICATE_SAME_ACCESS = 2;

    static readonly Guid IID_IGraphicsCaptureItem = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    static readonly Guid IID_IDXGIDevice = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    static readonly Guid IID_IDXGIFactory1 = new("770aae78-f26f-4dba-a829-253c83d1b387");
    static readonly Guid IID_IDXGIResource1 = new("30961379-4609-4a41-998e-54fe567ee0c1");
    static readonly Guid IID_ID3D11Texture2D = new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
    static readonly Guid IID_IDirect3DDxgiInterfaceAccess = new("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");

    static IntPtr d3d, context, query, parentProcess;
    static IDirect3DDevice winrtDevice;
    static Ring ring;
    static readonly List<Ring> retired = new();
    static readonly object gpuLock = new();
    static readonly object outLock = new();
    static int nextGen;

    // Последний отправленный кадр — для повтора, пока источник не меняется (под gpuLock)
    const int RepeatMs = 100;
    static Ring lastRing;
    static int lastSlot = -1, lastW, lastH;
    static long lastEmit, lastTs;

    static void** VTable(IntPtr p) => *(void***)p;
    static void Check(int hr, string what) { if (hr < 0) throw new Exception($"{what}: 0x{hr:X8}"); }
    static string Esc(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    static void Emit(string json)
    {
        lock (outLock)
        {
            Console.Out.Write(json);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
    }

    static void Fail(string message, int code = 1)
    {
        Emit($"{{\"type\":\"error\",\"message\":\"{Esc(message)}\"}}");
        Shutdown(code);
    }

    static void Shutdown(int code)
    {
        // Закрываем свои хэндлы в процессе Electron, иначе текстуры останутся в видеопамяти до его выхода
        lock (gpuLock)
        {
            foreach (var r in retired.Append(ring).Where(r => r != null)) CloseRemoteHandles(r);
        }
        Environment.Exit(code);
    }

    static Dictionary<string, string> ParseArgs(string[] args)
    {
        var result = new Dictionary<string, string>();
        for (int i = 0; i + 1 < args.Length; i += 2) result[args[i].TrimStart('-')] = args[i + 1];
        return result;
    }

    /// <summary>Адаптер DXGI той же видеокарты, на которой работает Chromium (иначе импорт текстур не сработает).</summary>
    static (IntPtr adapter, string name) FindAdapter(string gpu)
    {
        if (string.IsNullOrEmpty(gpu)) return (IntPtr.Zero, "по умолчанию");
        var parts = gpu.Split(':');
        uint vendor = uint.Parse(parts[0], CultureInfo.InvariantCulture), device = uint.Parse(parts[1], CultureInfo.InvariantCulture);
        var iid = IID_IDXGIFactory1;
        Check(CreateDXGIFactory1(ref iid, out var factory), "CreateDXGIFactory1");
        byte* desc = stackalloc byte[320]; // DXGI_ADAPTER_DESC1
        try
        {
            for (uint i = 0; ; i++)
            {
                IntPtr adapter;
                int hr = ((delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, int>)VTable(factory)[12])(factory, i, &adapter); // EnumAdapters1
                if (hr < 0) break;
                ((delegate* unmanaged[Stdcall]<IntPtr, byte*, int>)VTable(adapter)[10])(adapter, desc); // GetDesc1
                uint v = *(uint*)(desc + 256), d = *(uint*)(desc + 260);
                if (v == vendor && d == device) return (adapter, new string((char*)desc).TrimEnd('\0'));
                Marshal.Release(adapter);
            }
        }
        finally { Marshal.Release(factory); }
        return (IntPtr.Zero, "по умолчанию (нужная видеокарта не найдена)");
    }

    static GraphicsCaptureItem CreateItem(Dictionary<string, string> a, out IntPtr monitor)
    {
        var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
        var iid = IID_IGraphicsCaptureItem;
        IntPtr ptr;
        if (a.TryGetValue("window", out var hwndText))
        {
            var hwnd = new IntPtr(long.Parse(hwndText, CultureInfo.InvariantCulture));
            if (!IsWindow(hwnd)) throw new Exception("окно не найдено");
            monitor = MonitorFromWindow(hwnd, 2 /* NEAREST */);
            ptr = interop.CreateForWindow(hwnd, ref iid);
        }
        else
        {
            var xy = a["point"].Split(',').Select(s => int.Parse(s, CultureInfo.InvariantCulture)).ToArray();
            monitor = MonitorFromPoint(((long)xy[1] << 32) | (uint)xy[0], 2 /* NEAREST */);
            ptr = interop.CreateForMonitor(monitor, ref iid);
        }
        var item = MarshalInterface<GraphicsCaptureItem>.FromAbi(ptr);
        Marshal.Release(ptr);
        return item;
    }

    static void CloseRemoteHandles(Ring r)
    {
        foreach (var h in r.RemoteHandles)
            if (h != 0) DuplicateHandle(parentProcess, new IntPtr(h), IntPtr.Zero, out _, 0, false, DUPLICATE_CLOSE_SOURCE);
        Array.Clear(r.RemoteHandles);
    }

    /// <summary>Новое кольцо общих текстур. Вызывается под gpuLock.</summary>
    static void CreateRing(int width, int height, int count, string adapterName)
    {
        var r = new Ring { Gen = ++nextGen, Width = width, Height = height, Textures = new IntPtr[count], RemoteHandles = new long[count] };
        for (int i = 0; i < count; i++)
        {
            var desc = new Texture2DDesc
            {
                Width = (uint)width, Height = (uint)height, MipLevels = 1, ArraySize = 1, Format = DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleCount = 1, BindFlags = BIND_SHADER_RESOURCE | BIND_RENDER_TARGET, MiscFlags = MISC_SHARED | MISC_SHARED_NTHANDLE,
            };
            IntPtr texture;
            Check(((delegate* unmanaged[Stdcall]<IntPtr, Texture2DDesc*, IntPtr, IntPtr*, int>)VTable(d3d)[5])(d3d, &desc, IntPtr.Zero, &texture), "CreateTexture2D");
            r.Textures[i] = texture;
            var iid = IID_IDXGIResource1;
            Check(Marshal.QueryInterface(texture, in iid, out var resource), "IDXGIResource1");
            IntPtr shared;
            Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, IntPtr, IntPtr*, int>)VTable(resource)[13])(resource, IntPtr.Zero, 0x80000000 | 1, IntPtr.Zero, &shared), "CreateSharedHandle");
            Marshal.Release(resource);
            if (!DuplicateHandle(GetCurrentProcess(), shared, parentProcess, out var remote, 0, false, DUPLICATE_SAME_ACCESS))
                throw new Exception("DuplicateHandle в процесс Electron не удался");
            CloseHandle(shared);
            r.RemoteHandles[i] = (long)remote;
        }
        r.Free = new ConcurrentQueue<int>(Enumerable.Range(0, count));
        if (ring != null) retired.Add(ring);
        ring = r;
        var handles = string.Join(",", r.RemoteHandles.Select(h => $"\"{h}\""));
        Emit($"{{\"type\":\"ready\",\"gen\":{r.Gen},\"width\":{width},\"height\":{height},\"handles\":[{handles}],\"adapter\":\"{Esc(adapterName)}\"}}");
    }

    /// <summary>Копирует левый верхний угол w×h и ждёт конца копирования: Chromium читает текстуру на своём устройстве.</summary>
    static void CopyAndWait(IntPtr dst, IntPtr src, int w, int h)
    {
        var box = new Box { Right = (uint)w, Bottom = (uint)h, Back = 1 };
        ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, uint, uint, uint, IntPtr, uint, Box*, void>)VTable(context)[46])(
            context, dst, 0, 0, 0, 0, src, 0, &box); // CopySubresourceRegion
        ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, void>)VTable(context)[28])(context, query);  // End
        ((delegate* unmanaged[Stdcall]<IntPtr, void>)VTable(context)[111])(context);                // Flush
        int done = 0;
        while (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int*, uint, uint, int>)VTable(context)[29])(context, query, &done, 4, 0) == 1)
            Thread.SpinWait(20); // GetData
    }

    /// <summary>Сообщает Electron о готовом кадре. Вызывается под gpuLock.</summary>
    static void EmitFrame(Ring r, int slot, long tsMicros, int w, int h)
    {
        // Метки времени только растут: кадр с меньшей меткой WebRTC выбросит (повтор мог успеть раньше)
        long ts = Math.Max(tsMicros, lastTs + 1);
        Emit($"{{\"type\":\"frame\",\"gen\":{r.Gen},\"i\":{slot},\"ts\":{ts},\"w\":{w},\"h\":{h}}}");
        (lastRing, lastSlot, lastW, lastH, lastTs, lastEmit) = (r, slot, w, h, ts, Stopwatch.GetTimestamp());
    }

    static long QpcMicroseconds() => (long)(Stopwatch.GetTimestamp() * (1_000_000.0 / Stopwatch.Frequency));

    /// <summary>Свободная текстура кольца, но не busy (источник копии). Вызывается под gpuLock.</summary>
    static bool TryTakeOtherSlot(Ring r, int busy, out int slot)
    {
        for (int n = r.Free.Count; n > 0; n--)
        {
            if (!r.Free.TryDequeue(out slot)) break;
            if (slot != busy) return true;
            r.Free.Enqueue(slot);
        }
        slot = -1;
        return false;
    }

    /// <summary>
    /// WGC присылает кадр, только когда картинка изменилась: со статичного окна приходит один кадр и всё.
    /// Энкодеру тогда нечего кодировать, и если ключевой кадр потерялся или пришёл битым, зритель ждёт
    /// до первого изменения в окне — его запрос ключевого кадра (PLI) выполнить не из чего. Поэтому,
    /// пока новых кадров нет, последний повторяется 10 раз в секунду. Копией в другую текстуру кольца:
    /// ту же текстуру с новой меткой времени Chromium отбрасывает как дубликат.
    /// </summary>
    static void RepeatLastFrame()
    {
        long interval = Stopwatch.Frequency * RepeatMs / 1000;
        while (true)
        {
            Thread.Sleep(RepeatMs / 2);
            try
            {
                lock (gpuLock)
                {
                    var r = ring;
                    if (lastRing != r || lastSlot < 0 || Stopwatch.GetTimestamp() - lastEmit < interval) continue;
                    if (!TryTakeOtherSlot(r, lastSlot, out int slot)) continue; // все текстуры заняты — повторим позже
                    CopyAndWait(r.Textures[slot], r.Textures[lastSlot], lastW, lastH);
                    EmitFrame(r, slot, QpcMicroseconds(), lastW, lastH);
                }
            }
            catch (Exception e)
            {
                Fail(e.Message);
            }
        }
    }

    static void ReadCommands()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var p = line.Split(' ');
            if (p.Length == 3 && p[0] == "free" && int.TryParse(p[1], out var gen) && int.TryParse(p[2], out var slot))
            {
                var r = ring;
                if (r != null && r.Gen == gen) r.Free.Enqueue(slot);
            }
            else if (p.Length == 2 && p[0] == "gen" && int.TryParse(p[1], out var current))
            {
                // Electron больше не импортирует старые кольца — закрываем их хэндлы в его процессе.
                // Сами текстуры живут, пока их держит Chromium (у него свои копии хэндлов).
                lock (gpuLock)
                {
                    foreach (var old in retired.Where(r => r.Gen < current).ToList())
                    {
                        CloseRemoteHandles(old);
                        foreach (var t in old.Textures) Marshal.Release(t);
                        retired.Remove(old);
                    }
                }
            }
        }
        Shutdown(0);
    }

    static void Main(string[] args)
    {
        try
        {
            Run(ParseArgs(args));
        }
        catch (Exception e)
        {
            Fail(e.Message);
        }
    }

    static void Run(Dictionary<string, string> a)
    {
        if (!GraphicsCaptureSession.IsSupported()) throw new Exception("Windows Graphics Capture не поддерживается этой версией Windows");
        int parentPid = int.Parse(a["parent"], CultureInfo.InvariantCulture);
        double fps = double.Parse(a.GetValueOrDefault("fps", "120"), CultureInfo.InvariantCulture);
        int ringSize = int.Parse(a.GetValueOrDefault("ring", "8"), CultureInfo.InvariantCulture);

        parentProcess = OpenProcess(0x0040 /* PROCESS_DUP_HANDLE */, false, parentPid);
        if (parentProcess == IntPtr.Zero) throw new Exception($"нет доступа к процессу {parentPid}");

        var (adapter, adapterName) = FindAdapter(a.GetValueOrDefault("gpu"));
        Check(D3D11CreateDevice(adapter, adapter == IntPtr.Zero ? 1 /* HARDWARE */ : 0 /* UNKNOWN */, IntPtr.Zero, 0x20 /* BGRA_SUPPORT */,
            IntPtr.Zero, 0, 7, out d3d, out _, out context), "D3D11CreateDevice");
        if (adapter != IntPtr.Zero) Marshal.Release(adapter);
        var dxgiIid = IID_IDXGIDevice;
        Check(Marshal.QueryInterface(d3d, in dxgiIid, out var dxgi), "IDXGIDevice");
        Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var inspectable), "CreateDirect3D11DeviceFromDXGIDevice");
        Marshal.Release(dxgi);
        winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        Marshal.Release(inspectable);
        long queryDesc = 0; // D3D11_QUERY_EVENT
        IntPtr q;
        Check(((delegate* unmanaged[Stdcall]<IntPtr, void*, IntPtr*, int>)VTable(d3d)[24])(d3d, &queryDesc, &q), "CreateQuery");
        query = q;

        try { GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless).AsTask().Wait(2000); } catch { }

        var item = CreateItem(a, out var monitor);
        item.Closed += (_, _) =>
        {
            Emit("{\"type\":\"closed\"}");
            Shutdown(0);
        };
        // Closed приходит не всегда (например, если процесс окна убит) — дополнительно проверяем окно
        if (a.TryGetValue("window", out var watchedText))
        {
            var watched = new IntPtr(long.Parse(watchedText, CultureInfo.InvariantCulture));
            new Thread(() =>
            {
                while (IsWindow(watched)) Thread.Sleep(500);
                Emit("{\"type\":\"closed\"}");
                Shutdown(0);
            }) { IsBackground = true }.Start();
        }

        // Кольцо с запасом: окно может вырасти до размера монитора без пересоздания текстур
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        GetMonitorInfoW(monitor, ref info);
        int capW = Math.Max(item.Size.Width, info.Right - info.Left) & ~1;
        int capH = Math.Max(item.Size.Height, info.Bottom - info.Top) & ~1;
        lock (gpuLock) CreateRing(capW, capH, ringSize, adapterName);
        new Thread(ReadCommands) { IsBackground = true }.Start();

        var poolSize = item.Size;
        var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, poolSize);
        var session = pool.CreateCaptureSession(item);
        try { session.IsBorderRequired = false; } catch { }
        // Главное отличие от захвата Chromium: без этого Windows 11 24H2+ отдаёт кадр не чаще раза в 16 мс
        try { session.MinUpdateInterval = TimeSpan.FromMilliseconds(1); } catch { }

        long period = (long)(TimeSpan.TicksPerSecond / fps);
        long tolerance = TimeSpan.TicksPerMillisecond * 3;
        long nextDue = 0, sent = 0, dropped = 0, copyTicks = 0;
        var statsClock = Stopwatch.StartNew();
        var accessIid = IID_IDirect3DDxgiInterfaceAccess;
        var textureIid = IID_ID3D11Texture2D;

        pool.FrameArrived += (sender, _) =>
        {
            try
            {
                using var frame = sender.TryGetNextFrame();
                if (frame == null) return;
                var content = frame.ContentSize;
                if (content.Width != poolSize.Width || content.Height != poolSize.Height)
                {
                    // Окно изменило размер — пересоздаём пул под новый размер (текущий кадр ещё старого)
                    poolSize = content;
                    sender.Recreate(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, content);
                }

                long t = frame.SystemRelativeTime.Ticks;
                if (t + tolerance < nextDue) return; // выдерживаем целевую частоту кадров
                nextDue = Math.Max(nextDue + period, t);

                var surface = frame.Surface.Description;
                int w = Math.Min(content.Width, surface.Width) & ~1;
                int h = Math.Min(content.Height, surface.Height) & ~1;
                if (w < 2 || h < 2) return;

                lock (gpuLock)
                {
                    if (w > ring.Width || h > ring.Height) CreateRing(Math.Max(w, ring.Width), Math.Max(h, ring.Height), ringSize, adapterName);
                    var r = ring;
                    if (!r.Free.TryDequeue(out var slot))
                    {
                        dropped++; // Electron/WebRTC не успевают — пропускаем кадр
                        return;
                    }

                    var started = Stopwatch.GetTimestamp();
                    IntPtr native = ((IWinRTObject)frame.Surface).NativeObject.ThisPtr;
                    Check(Marshal.QueryInterface(native, in accessIid, out var access), "IDirect3DDxgiInterfaceAccess");
                    IntPtr source;
                    var tiid = textureIid;
                    Check(((delegate* unmanaged[Stdcall]<IntPtr, Guid*, IntPtr*, int>)VTable(access)[3])(access, &tiid, &source), "GetInterface");
                    Marshal.Release(access);
                    CopyAndWait(r.Textures[slot], source, w, h);
                    Marshal.Release(source);
                    copyTicks += Stopwatch.GetTimestamp() - started;
                    sent++;
                    EmitFrame(r, slot, t / 10, w, h); // SystemRelativeTime — тоже QPC, в единицах 100 нс
                }

                if (statsClock.ElapsedMilliseconds >= 2000)
                {
                    double seconds = statsClock.Elapsed.TotalSeconds;
                    double copyMs = sent > 0 ? copyTicks * 1000.0 / Stopwatch.Frequency / sent : 0;
                    Emit(string.Format(CultureInfo.InvariantCulture, "{{\"type\":\"stats\",\"fps\":{0:0.0},\"dropped\":{1},\"copyMs\":{2:0.000}}}", sent / seconds, dropped, copyMs));
                    sent = dropped = copyTicks = 0;
                    statsClock.Restart();
                }
            }
            catch (Exception e)
            {
                Fail(e.Message);
            }
        };

        new Thread(RepeatLastFrame) { IsBackground = true }.Start();
        session.StartCapture();
        Thread.Sleep(Timeout.Infinite);
    }
}

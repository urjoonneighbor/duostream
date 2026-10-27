// Звук одного приложения — того, чьё окно транслируется, — вместо всего системного звука.
//
// Windows 10 2004+ умеет захватывать звук процесса вместе с его дочерними процессами (Process Loopback,
// ActivateAudioInterfaceAsync с VAD\Process_Loopback). Chromium это тоже умеет (applicationLoopback),
// но Electron в обработчике getDisplayMedia разрешает только системный loopback, поэтому делаем сами.
//
// Аргументы: --parent <pid Electron> --audio-window <HWND>
// stdout: непрерывный поток float32, стерео с чередованием каналов, 48 кГц (без заголовков)
// stderr: «error: …» перед выходом с ошибкой;  stdin: конец потока — завершение работы
using System.Globalization;
using System.Runtime.InteropServices;

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject { }

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}

/// <summary>Обработчик завершения активации; COM требует, чтобы он был agile.</summary>
[ComVisible(true)]
sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEventSlim Done = new();
    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) => Done.Set();
}

static unsafe class AppAudio
{
    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation operation);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    const string ProcessLoopbackDevice = @"VAD\Process_Loopback";
    const int ActivationTypeProcessLoopback = 1;
    const int IncludeTargetProcessTree = 0;
    const ushort VT_BLOB = 65;
    const uint StreamFlagsLoopback = 0x00020000, StreamFlagsEventCallback = 0x00040000;
    const uint StreamFlagsAutoConvertPcm = 0x80000000, StreamFlagsSrcDefaultQuality = 0x08000000;
    const uint BufferFlagsSilent = 0x2;
    const int SampleRate = 48000, Channels = 2;

    static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    static void Fail(string message)
    {
        Console.Error.WriteLine($"error: {message}");
        Console.Error.Flush();
        Environment.Exit(2);
    }

    public static void Run(Dictionary<string, string> a)
    {
        try
        {
            Capture(a);
        }
        catch (Exception e)
        {
            Fail(e.Message);
        }
    }

    static void Capture(Dictionary<string, string> a)
    {
        var hwnd = new IntPtr(long.Parse(a["audio-window"], CultureInfo.InvariantCulture));
        GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == 0) throw new Exception("окно не найдено");

        // Конец stdin — Electron больше не нужен звук (или он сам завершился)
        new Thread(() =>
        {
            while (Console.In.ReadLine() != null) { }
            Environment.Exit(0);
        }) { IsBackground = true }.Start();

        // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType; { TargetProcessId; ProcessLoopbackMode } } в PROPVARIANT(VT_BLOB)
        IntPtr parameters = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(parameters, 0, ActivationTypeProcessLoopback);
        Marshal.WriteInt32(parameters, 4, (int)pid);
        Marshal.WriteInt32(parameters, 8, IncludeTargetProcessTree);
        IntPtr variant = Marshal.AllocHGlobal(24);
        new Span<byte>((void*)variant, 24).Clear();
        Marshal.WriteInt16(variant, 0, (short)VT_BLOB);
        Marshal.WriteInt32(variant, 8, 12);
        Marshal.WriteIntPtr(variant, 16, parameters);

        var handler = new ActivationHandler();
        var iid = IID_IAudioClient;
        ActivateAudioInterfaceAsync(ProcessLoopbackDevice, ref iid, variant, handler, out var operation);
        if (!handler.Done.Wait(5000)) throw new Exception("активация захвата звука приложения не завершилась");
        operation.GetActivateResult(out int hr, out object activated);
        if (hr < 0) throw new Exception($"захват звука приложения недоступен: 0x{hr:X8}");
        var client = (IAudioClient)activated;

        // WAVEFORMATEX: float32, 2 канала, 48 кГц — Windows сама переведёт звук приложения в этот формат
        IntPtr format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, 3);
        Marshal.WriteInt16(format, 2, Channels);
        Marshal.WriteInt32(format, 4, SampleRate);
        Marshal.WriteInt32(format, 8, SampleRate * Channels * 4);
        Marshal.WriteInt16(format, 12, Channels * 4);
        Marshal.WriteInt16(format, 14, 32);
        Marshal.WriteInt16(format, 16, 0);
        uint flags = StreamFlagsLoopback | StreamFlagsEventCallback | StreamFlagsAutoConvertPcm | StreamFlagsSrcDefaultQuality;
        int init = client.Initialize(0 /* SHARED */, flags, 200_000 /* 20 мс */, 0, format, IntPtr.Zero);
        if (init < 0) throw new Exception($"IAudioClient.Initialize: 0x{init:X8}");

        IntPtr ready = CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
        client.SetEventHandle(ready);
        var captureIid = IID_IAudioCaptureClient;
        client.GetService(ref captureIid, out object service);
        var capture = (IAudioCaptureClient)service;

        using var stdout = Console.OpenStandardOutput();
        var buffer = new byte[SampleRate / 10 * Channels * 4]; // до 100 мс за пакет
        if (client.Start() < 0) throw new Exception("IAudioClient.Start не удался");
        while (true)
        {
            WaitForSingleObject(ready, 100);
            while (capture.GetNextPacketSize(out uint packet) >= 0 && packet > 0)
            {
                if (capture.GetBuffer(out IntPtr data, out uint frames, out uint bufferFlags, out _, out _) < 0) break;
                int bytes = (int)frames * Channels * 4;
                if (bytes > buffer.Length) buffer = new byte[bytes];
                if ((bufferFlags & BufferFlagsSilent) != 0) Array.Clear(buffer, 0, bytes);
                else Marshal.Copy(data, buffer, 0, bytes);
                capture.ReleaseBuffer(frames);
                stdout.Write(buffer, 0, bytes);
            }
            stdout.Flush();
        }
    }
}

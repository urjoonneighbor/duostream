'use strict';
/**
 * Автоматический проброс портов на роутере через UPnP IGD — вместо ручной настройки «Виртуальных серверов».
 *
 * Стример при подключении просит роутер открыть TCP-порт сигнального сервера и UDP-диапазон WebRTC,
 * при отключении и выходе — закрыть. Аренда на час с продлением каждые 20 минут: если приложение
 * упадёт, роутер сам закроет порты. Заодно роутер сообщает свой внешний IP: внешний сайт для его
 * определения не нужен, а серый адрес (CGNAT провайдера) видно сразу.
 *
 * Без зависимостей: SSDP (поиск роутера) + SOAP-запросы по HTTP в локальной сети.
 */
const dgram = require('node:dgram');
const http = require('node:http');
const os = require('node:os');

const SSDP_ADDRESS = '239.255.255.250';
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const DISCOVER_MS = 2500;
const LEASE_SECONDS = 3600;
const RENEW_MS = 20 * 60 * 1000;
const DESCRIPTION = 'DuoStream';

/** Серые адреса: если такой вернул роутер как внешний, белого IP у него нет */
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, localAddress: req.socket?.localAddress }));
    });
    req.on('timeout', () => req.destroy(new Error('роутер не ответил')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const tag = (xml, name) => new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1]?.trim() ?? null;

/** Ищет роутер: LOCATION-адреса описаний из ответов SSDP со всех сетевых интерфейсов IPv4 */
function discover() {
  const interfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a?.family === 'IPv4' && !a.internal);
  const locations = new Set();
  return new Promise((resolve) => {
    const sockets = interfaces.map((iface) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', (msg) => {
        const location = /^location:\s*(\S+)/im.exec(msg.toString())?.[1];
        if (location) locations.add(location);
      });
      socket.on('error', () => socket.close());
      socket.bind(0, iface.address, () => {
        for (const st of SEARCH_TARGETS) {
          const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
          socket.send(m, 1900, SSDP_ADDRESS, () => {});
        }
      });
      return socket;
    });
    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          // уже закрыт
        }
      }
      resolve([...locations]);
    }, DISCOVER_MS);
  });
}

/** Сервис WANIPConnection/WANPPPConnection из описания роутера */
async function findService(location) {
  const { body, localAddress } = await httpRequest(location);
  const base = tag(body, 'URLBase') || location;
  for (const [, block] of body.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const type = tag(block, 'serviceType');
    const control = tag(block, 'controlURL');
    if (type && control && /:WAN(IP|PPP)Connection:\d/.test(type)) {
      return {
        type,
        controlUrl: new URL(control, base).href,
        localAddress: (localAddress ?? '').replace(/^::ffff:/, ''),
        model: tag(body, 'friendlyName') ?? tag(body, 'modelName') ?? '',
      };
    }
  }
  return null;
}

class UpnpError extends Error {
  constructor(code, description) {
    super(`UPnP ${code}${description ? `: ${description}` : ''}`);
    this.code = Number(code);
  }
}

async function soap(service, action, args = {}) {
  const params = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  const body =
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${service.type}">${params}</u:${action}></s:Body></s:Envelope>`;
  const res = await httpRequest(service.controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"${service.type}#${action}"`,
      'content-length': Buffer.byteLength(body),
    },
    body,
  });
  if (res.status !== 200) throw new UpnpError(tag(res.body, 'errorCode') ?? res.status, tag(res.body, 'errorDescription'));
  return res.body;
}

class PortMapper {
  /** @param {(state:object) => void} onState */
  constructor(onState) {
    this.onState = onState;
    this.service = null;
    this.mappings = []; // [{protocol, port}]
    this.renewTimer = null;
    this.state = { status: 'off' };
  }

  set(state) {
    this.state = state;
    this.onState(state);
  }

  async gateway() {
    if (this.service) return this.service;
    for (const location of await discover()) {
      try {
        const service = await findService(location);
        if (service) return (this.service = service);
      } catch {
        // не роутер или не ответил — пробуем следующий
      }
    }
    return null;
  }

  async addMapping({ protocol, port }) {
    const args = (lease) => ({
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: protocol,
      NewInternalPort: port,
      NewInternalClient: this.service.localAddress,
      NewEnabled: 1,
      NewPortMappingDescription: DESCRIPTION,
      NewLeaseDuration: lease,
    });
    try {
      await soap(this.service, 'AddPortMapping', args(LEASE_SECONDS));
    } catch (err) {
      // 725: роутер умеет только бессрочные правила — тогда удаляем их сами при выходе
      if (err.code === 725) await soap(this.service, 'AddPortMapping', args(0));
      else throw err;
    }
  }

  /**
   * Открывает порты, пока стример подключён.
   * @param {{tcp:number[], udp:number[]}} ports
   */
  async open({ tcp = [], udp = [] }) {
    await this.close();
    this.set({ status: 'working' });
    const service = await this.gateway();
    if (!service) {
      this.set({ status: 'unavailable', message: 'роутер не ответил по UPnP (выключен в настройках роутера или не поддерживается)' });
      return this.state;
    }

    let externalIp = null;
    try {
      externalIp = tag(await soap(service, 'GetExternalIPAddress'), 'NewExternalIPAddress');
    } catch {
      // не критично
    }
    const wanted = [...tcp.map((port) => ({ protocol: 'TCP', port })), ...udp.map((port) => ({ protocol: 'UDP', port }))];
    const failed = [];
    let manual = 0;
    for (const mapping of wanted) {
      try {
        await this.addMapping(mapping);
        this.mappings.push(mapping);
      } catch (err) {
        // 718: такой порт уже занят правилом — обычно это ручной проброс на этот же ПК
        if (err.code === 718) manual++;
        else failed.push(`${mapping.protocol} ${mapping.port}: ${err.message}`);
      }
    }
    this.renewTimer = setInterval(() => this.renew(), RENEW_MS);
    const cgnat = Boolean(externalIp && PRIVATE_IP.test(externalIp));
    const ok = failed.length === 0;
    this.set({
      status: ok ? 'ok' : 'partial',
      router: service.model,
      externalIp,
      cgnat,
      opened: this.mappings.length,
      manual,
      message: failed.slice(0, 3).join('; '),
    });
    return this.state;
  }

  async renew() {
    for (const mapping of this.mappings) {
      try {
        await this.addMapping(mapping);
      } catch {
        // роутер перезагрузился или перестал отвечать — следующая попытка через 20 минут
      }
    }
  }

  /** Закрывает открытые порты (при отключении стримера и выходе из приложения) */
  async close() {
    clearInterval(this.renewTimer);
    this.renewTimer = null;
    const mappings = this.mappings;
    this.mappings = [];
    // По одному: дешёвые роутеры плохо переносят пачку параллельных SOAP-запросов
    for (const m of mappings) {
      await soap(this.service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.port, NewProtocol: m.protocol }).catch(() => {});
    }
    if (this.state.status !== 'off') this.set({ status: 'off' });
  }
}

module.exports = { PortMapper, PRIVATE_IP };

/**
 * 读取本机代理客户端（v2rayN）当前选中的出口节点，供 /nowapi 使用。
 *
 * 为什么不直接看 sing-box 的运行期配置：v2rayN 拉起内核后会把那份临时 config.json 删掉
 * （实测 bin/sing_box 下只剩 sing-box.exe），拿不到。而库里存的字段才足以还原出
 * 可以直接导入客户端的分享链接，所以走数据库这条路：
 *
 *   guiConfigs/guiNConfig.json  →  IndexId，当前选中的节点编号
 *   guiConfigs/guiNDB.db        →  ProfileItem 表里该编号的完整字段
 *                                  （ProtoExtra / TransportExtra 是 JSON，装着 flow、
 *                                    ws 的 Host/Path、ss 的加密方式这些细节）
 *
 * v2rayN v7 的 EConfigType 枚举（按库里实测数据核对过，不是猜的）：
 *   1 vmess / 2 custom / 3 ss / 4 socks / 5 vless / 6 trojan
 *   7 hysteria2 / 8 tuic / 9 wireguard / 10 http / 11 anytls
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const PROTOCOL = {
  1: 'vmess',
  2: 'custom',
  3: 'ss',
  4: 'socks',
  5: 'vless',
  6: 'trojan',
  7: 'hysteria2',
  8: 'tuic',
  9: 'wireguard',
  10: 'http',
  11: 'anytls',
};

/** 布尔字段在库里可能是 1 / '1' / 'true' 三种形态 */
const truthy = (v) => v === 1 || v === true || v === '1' || v === 'true';

/** 空值一律不出现在查询串里，避免生成 `sni=` 这种会被部分客户端当成空 SNI 的写法 */
function query(pairs) {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64').replace(/=+$/, '');

/** Xray 把 tcp 叫 raw，分享链接里仍要写回 tcp，否则多数客户端不认 */
const netName = (net) => (net === 'raw' ? 'tcp' : net || 'tcp');

function safeJson(s) {
  if (!s || typeof s !== 'string') return {};
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

/**
 * 由数据库行还原分享链接。
 * 返回 null 表示该协议不去编链接（custom / wireguard 这类没法用一串 URI 表达）。
 */
function buildLink(row) {
  const type = Number(row.ConfigType);
  const proto = PROTOCOL[type] || '';
  const addr = row.Address || '';
  const port = row.Port || '';
  const name = row.Remarks || '';
  const hash = name ? `#${encodeURIComponent(name)}` : '';
  const extra = safeJson(row.ProtoExtra);
  const transport = safeJson(row.TransportExtra);
  const net = netName(row.Network);
  const insecure = truthy(row.AllowInsecure);

  switch (type) {
    case 5: {
      // vless：字段顺序对齐 v2rayN 自己的导出格式，保证和客户端复制出来的完全一致。
      // grpc 的 Path 在链接里叫 serviceName，不能同时出现，否则客户端会认错传输层。
      const isGrpc = net === 'grpc' || net === 'gun';
      const q = query([
        ['encryption', extra.VlessEncryption || 'none'],
        ['flow', extra.Flow],
        ['security', row.StreamSecurity || 'none'],
        ['sni', row.Sni],
        ['fp', row.Fingerprint],
        ['alpn', row.Alpn],
        ['insecure', insecure ? '1' : null],
        ['allowInsecure', insecure ? '1' : null],
        ['type', net],
        ['host', transport.Host],
        [isGrpc ? 'serviceName' : 'path', transport.Path],
      ]);
      return `vless://${encodeURIComponent(row.Password || '')}@${addr}:${port}?${q}${hash}`;
    }
    case 6: {
      const q = query([
        ['security', row.StreamSecurity || 'tls'],
        ['sni', row.Sni],
        ['alpn', row.Alpn],
        ['fp', row.Fingerprint],
        ['allowInsecure', insecure ? '1' : null],
        ['type', net],
        ['host', transport.Host],
        ['path', transport.Path],
      ]);
      return `trojan://${encodeURIComponent(row.Password || '')}@${addr}:${port}?${q}${hash}`;
    }
    case 7: {
      const q = query([
        ['security', row.StreamSecurity || 'tls'],
        ['sni', row.Sni],
        ['insecure', insecure ? '1' : null],
        ['allowInsecure', insecure ? '1' : null],
      ]);
      return `hysteria2://${encodeURIComponent(row.Password || '')}@${addr}:${port}?${q}${hash}`;
    }
    case 8: {
      const q = query([
        ['sni', row.Sni],
        ['alpn', row.Alpn],
        ['congestion_control', extra.CongestionControl],
        ['udp_relay_mode', extra.UdpRelayMode],
        ['allow_insecure', insecure ? '1' : null],
      ]);
      const user = encodeURIComponent(row.Username || row.Password || '');
      return `tuic://${user}:${encodeURIComponent(row.Password || '')}@${addr}:${port}?${q}${hash}`;
    }
    case 11: {
      const q = query([
        ['security', row.StreamSecurity || 'tls'],
        ['sni', row.Sni],
        ['insecure', insecure ? '1' : null],
        ['allowInsecure', insecure ? '1' : null],
      ]);
      return `anytls://${encodeURIComponent(row.Password || '')}@${addr}:${port}?${q}${hash}`;
    }
    case 3: {
      const method = extra.SsMethod || 'aes-256-gcm';
      return `ss://${b64(`${method}:${row.Password || ''}`)}@${addr}:${port}${hash}`;
    }
    case 4: {
      const auth = row.Username || row.Password ? `${b64(`${row.Username || ''}:${row.Password || ''}`)}@` : '';
      return `socks://${auth}${addr}:${port}${hash}`;
    }
    case 10: {
      const auth = row.Username || row.Password ? `${b64(`${row.Username || ''}:${row.Password || ''}`)}@` : '';
      return `http://${auth}${addr}:${port}${hash}`;
    }
    case 1: {
      // vmess 是 base64 包一层 JSON，字段名沿用 v2ray 那一套短名
      const obj = {
        v: '2',
        ps: name,
        add: addr,
        port: String(port),
        id: row.Password || row.Id || '',
        aid: String(row.AlterId || 0),
        scy: 'auto',
        net,
        type: transport.RawHeaderType || 'none',
        host: transport.Host || '',
        path: transport.Path || '',
        tls: row.StreamSecurity || '',
        sni: row.Sni || '',
        alpn: row.Alpn || '',
        fp: row.Fingerprint || '',
      };
      return `vmess://${Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64')}`;
    }
    default:
      // custom(2) 是整份 yaml 配置，wireguard(9) 需要私钥/对端公钥等一大堆字段，
      // 都不适合压成一条 URI，交给调用方按 protocol 字段自己判断
      return null;
  }
}

/** 候选目录：环境变量优先，其次是便携版常见落点 */
function candidates() {
  const list = [];
  if (config.v2rayNDir) list.push(config.v2rayNDir);
  list.push(
    'D:/VPN/v2rayN-windows-64',
    'C:/VPN/v2rayN-windows-64',
    'D:/v2rayN',
    'C:/v2rayN',
    'D:/Program Files/v2rayN-windows-64',
    'C:/Program Files/v2rayN-windows-64',
  );
  return list;
}

function pairIn(dir) {
  return {
    dir,
    cfg: path.join(dir, 'guiConfigs', 'guiNConfig.json'),
    db: path.join(dir, 'guiConfigs', 'guiNDB.db'),
  };
}

function resolveDir() {
  for (const dir of candidates()) {
    try {
      const p = pairIn(dir);
      if (fs.existsSync(p.cfg) && fs.existsSync(p.db)) return p;
    } catch {
      /* 权限问题时继续试下一个 */
    }
  }
  return null;
}

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return st;
  } catch {
    return null;
  }
}

/** 缓存键用两个文件的 mtime+size：v2rayN 切节点会立刻改写它们，切完下一次请求就能反映出来 */
let cache = { key: '', at: 0, data: null };

/**
 * 取当前节点。
 * @returns {{ok:true, protocol, name, address, port, link, updatedAt, source}|{ok:false, error, message}}
 */
export function getCurrentNode() {
  const p = resolveDir();
  if (!p) {
    return {
      ok: false,
      error: 'v2rayn_not_found',
      message: '未找到 v2rayN 数据目录，请在 .env 里设置 V2RAYN_DIR 指向 v2rayN 便携版根目录',
    };
  }

  const stCfg = statOf(p.cfg);
  const stDb = statOf(p.db);
  if (!stCfg || !stDb) {
    return { ok: false, error: 'v2rayn_read_failed', message: '无法读取 v2rayN 配置文件（权限不足或文件被占用）' };
  }

  const key = `${p.cfg}|${stCfg.mtimeMs}|${stCfg.size}|${stDb.mtimeMs}|${stDb.size}`;
  if (cache.key === key && cache.data) return cache.data;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p.cfg, 'utf-8'));
  } catch (err) {
    return { ok: false, error: 'v2rayn_config_invalid', message: `guiNConfig.json 解析失败：${err.message}` };
  }

  const indexId = cfg.IndexId === null || cfg.IndexId === undefined ? '' : String(cfg.IndexId);
  if (!indexId) {
    return {
      ok: false,
      error: 'no_selection',
      message: 'v2rayN 里没有选中任何节点（guiNConfig.json 的 IndexId 为空）',
    };
  }

  let row;
  try {
    const db = new DatabaseSync(p.db, { readOnly: true });
    try {
      row = db.prepare('SELECT * FROM ProfileItem WHERE IndexId = ?').get(indexId);
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, error: 'db_read_failed', message: `读取 guiNDB.db 失败：${err.message}` };
  }

  if (!row) {
    return { ok: false, error: 'profile_missing', message: `节点 ${indexId} 在 ProfileItem 里不存在（可能刚被删除）` };
  }

  const data = {
    ok: true,
    protocol: PROTOCOL[Number(row.ConfigType)] || 'unknown',
    name: row.Remarks || '',
    address: row.Address || '',
    port: row.Port || '',
    network: netName(row.Network),
    security: row.StreamSecurity || '',
    link: buildLink(row),
    updatedAt: new Date(stDb.mtimeMs).toISOString(),
    source: { client: 'v2rayN', dir: p.dir, indexId },
  };

  cache = { key, at: Date.now(), data };
  return data;
}

/** 管理后台/排障用：清掉缓存，强制下次重新读盘 */
export function invalidateNodeCache() {
  cache = { key: '', at: 0, data: null };
}

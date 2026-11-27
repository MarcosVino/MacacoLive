import mqtt, { MqttClient } from 'mqtt';
import { SignalEnvelope } from './types';

const PUBLIC_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveRoomKey(
  roomCode: string,
  password: string
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(`macacolive:${roomCode.toLowerCase()}:${password}`),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(`macacolive-salt-v1:${roomCode.toLowerCase()}`),
      iterations: 25000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export class ServerlessRoomSignaling {
  public readonly selfId: string;
  private clients: MqttClient[] = [];
  private cryptoKey: CryptoKey | null = null;
  private topic = '';
  private seenIds = new Set<string>();
  private seenQueue: string[] = [];
  private onMessageCb: ((env: SignalEnvelope) => void) | null = null;
  private onBrokerStatusCb: ((connectedCount: number) => void) | null = null;
  private localBroadcast: BroadcastChannel | null = null;

  constructor(selfId?: string) {
    this.selfId = selfId || crypto.randomUUID().slice(0, 12);
  }

  public onMessage(cb: (env: SignalEnvelope) => void) {
    this.onMessageCb = cb;
  }

  public onBrokerStatus(cb: (connectedCount: number) => void) {
    this.onBrokerStatusCb = cb;
  }

  public async connect(roomCode: string, password = ''): Promise<void> {
    this.disconnect();
    const normalizedRoom = roomCode.trim().toLowerCase();
    const roomHash = await sha256Hex(`macacolive-room-v1:${normalizedRoom}`);
    this.topic = `macacolive/v1/${roomHash.slice(0, 32)}`;
    this.cryptoKey = await deriveRoomKey(normalizedRoom, password.trim());

    // Local fast-path if testing multiple tabs/windows in same profile
    try {
      this.localBroadcast = new BroadcastChannel(this.topic);
      this.localBroadcast.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          void this.handleRawPacket(ev.data);
        }
      };
    } catch {}

    await new Promise<void>((resolve) => {
      let resolved = false;

      const updateCount = () => {
        const connected = this.clients.filter((c) => c.connected).length;
        if (this.onBrokerStatusCb) {
          this.onBrokerStatusCb(connected);
        }
        if (connected > 0 && !resolved) {
          resolved = true;
          resolve();
        }
      };

      for (const url of PUBLIC_BROKERS) {
        try {
          const client = mqtt.connect(url, {
            clientId: `ml_${this.selfId}_${Math.random().toString(36).slice(2, 7)}`,
            clean: true,
            keepalive: 25,
            reconnectPeriod: 2500,
            connectTimeout: 7000,
          });

          client.on('connect', () => {
            client.subscribe(this.topic, { qos: 0 }, () => {
              updateCount();
            });
          });

          client.on('close', updateCount);
          client.on('offline', updateCount);
          client.on('error', () => {
            // Silently ignore single broker failure since we run multi-broker redundancy
          });

          client.on('message', (_topic, payload) => {
            void this.handleRawPacket(payload.toString('utf8'));
          });

          this.clients.push(client);
        } catch {}
      }

      // Resolve after max 4.5s even if slow network so UI remains responsive while reconnecting
      window.setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 4500);
    });
  }

  public async send(
    to: string,
    type: SignalEnvelope['type'],
    payload: unknown
  ): Promise<void> {
    if (!this.cryptoKey || !this.topic) return;

    const env: SignalEnvelope = {
      id: crypto.randomUUID(),
      from: this.selfId,
      to,
      type,
      payload,
      ts: Date.now(),
    };

    this.markSeen(env.id);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plainBytes = new TextEncoder().encode(JSON.stringify(env));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.cryptoKey,
      plainBytes
    );

    const wire = `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipherBuf))}`;

    if (this.localBroadcast) {
      try {
        this.localBroadcast.postMessage(wire);
      } catch {}
    }

    for (const client of this.clients) {
      if (client.connected) {
        client.publish(this.topic, wire, { qos: 0 });
      }
    }
  }

  private async handleRawPacket(wire: string) {
    if (!this.cryptoKey || !this.onMessageCb) return;
    const dotIdx = wire.indexOf('.');
    if (dotIdx <= 0) return;

    try {
      const iv = base64ToBytes(wire.slice(0, dotIdx));
      const cipher = base64ToBytes(wire.slice(dotIdx + 1));
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        this.cryptoKey,
        cipher as BufferSource
      );

      const env = JSON.parse(
        new TextDecoder().decode(plainBuf)
      ) as SignalEnvelope;

      if (!env || !env.id || env.from === this.selfId) return;
      if (env.to !== '*' && env.to !== this.selfId) return;
      if (this.seenIds.has(env.id)) return;

      this.markSeen(env.id);
      this.onMessageCb(env);
    } catch {
      // Wrong password or corrupted packet: ignore silently
    }
  }

  private markSeen(id: string) {
    this.seenIds.add(id);
    this.seenQueue.push(id);
    if (this.seenQueue.length > 1200) {
      const oldest = this.seenQueue.shift();
      if (oldest) this.seenIds.delete(oldest);
    }
  }

  public disconnect() {
    if (this.localBroadcast) {
      try {
        this.localBroadcast.close();
      } catch {}
      this.localBroadcast = null;
    }

    for (const c of this.clients) {
      try {
        c.end(true);
      } catch {}
    }
    this.clients = [];
    this.cryptoKey = null;
    this.seenIds.clear();
    this.seenQueue = [];
  }
}

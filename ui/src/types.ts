export interface AudioProcessInfo {
  pid: number;
  name: string;
  title: string;
  isDiscord: boolean;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export type CaptureSource = 'dxgi-monitor' | 'window-picker';

export type AudioCaptureMode =
  | 'exclude-discord'
  | 'include-process'
  | 'system-all'
  | 'none';

export type StreamProfile = 'cinema' | 'detail';

export type ResolutionPreset = '720p' | '1080p' | '1440p' | 'native';

export interface StreamQualityConfig {
  captureSource: CaptureSource;
  monitorIndex: number;
  resolution: ResolutionPreset;
  fps: 30 | 60;
  bitrateMbps: number;
  profile: StreamProfile;
  audioMode: AudioCaptureMode;
  targetPid: number;
  cascadeRelay: boolean;
}

export interface PeerInfo {
  peerId: string;
  nickname: string;
  isStreaming: boolean;
  cascadeRelay?: boolean;
  viewerCount?: number;
  streamLabel?: string;
  lastSeen: number;
}

export interface StreamStats {
  fps: number;
  width: number;
  height: number;
  bitrateMbps: number;
  rttMs: number;
  packetLossPct: number;
  codec: string;
  routeType: string;
  limitation?: string;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  notes: string;
}

export interface SignalEnvelope {
  id: string;
  from: string;
  to: string; // '*' or target peerId
  type:
    | 'announce'
    | 'welcome'
    | 'bye'
    | 'watch-request'
    | 'relay-assign'
    | 'offer'
    | 'answer'
    | 'ice'
    | 'reaction';
  payload: unknown;
  ts: number;
}

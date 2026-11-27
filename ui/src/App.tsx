import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel, User } from '@supabase/supabase-js';
import {
  Bell,
  BellOff,
  Camera,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Film,
  Gamepad2,
  Hash,
  LoaderCircle,
  Lock,
  LogOut,
  Maximize2,
  MessageSquare,
  Minimize2,
  MonitorPlay,
  MonitorUp,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Radio,
  RefreshCw,
  ShieldCheck,
  Shuffle,
  SlidersHorizontal,
  Square,
  Trash2,
  TriangleAlert,
  Tv,
  UserCheck,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import { BananaIcon, BananaOverlay } from './components/BananaOverlay';
import { RoomChat } from './components/RoomChat';
import { ServerLobby } from './components/ServerLobby';
import { ShareModal } from './components/ShareModal';
import { LogoMark } from './Logo';
import { nativeBridge } from './nativeBridge';
import { playBananaSound, playChatPop } from './soundEffects';
import {
  ChannelPresenceEntry,
  createServerChannel,
  createServerWithChannels,
  deleteServerChannel,
  fetchServerRoster,
  fetchUserProfileAndRooms,
  fetchUserServers,
  joinServerByInvite,
  leaveOrDeleteServer,
  removeSavedRoom,
  SavedRoomRecord,
  ServerChannelRecord,
  ServerMemberRecord,
  ServerRecord,
  supabase,
  toggleRoomPin,
  updateNickname,
  upsertSavedRoom,
} from './supabaseClient';
import {
  AudioCaptureMode,
  AudioProcessInfo,
  BananaThrowEvent,
  CaptureSource,
  ChatMessage,
  MonitorInfo,
  PeerInfo,
  ResolutionPreset,
  StreamQualityConfig,
  StreamStats,
  UpdateCheckResult,
} from './types';
import { MacacoWebRtcEngine } from './webrtcEngine';

const APP_VERSION = '1.7.0';
const CONFIRM_REDIRECT_URL = 'https://macacolive.netlify.app/confirm.html';

interface FloatingReaction {
  id: string;
  nick: string;
  emoji: string;
}

const DEFAULT_QUALITY: StreamQualityConfig = {
  captureSource: 'dxgi-monitor',
  monitorIndex: 0,
  resolution: '1080p',
  fps: 60,
  bitrateMbps: 12,
  profile: 'cinema',
  audioMode: 'exclude-discord',
  targetPid: 0,
  cascadeRelay: false,
};

const REACTIONS = ['😂', '🔥', '👏', '😮'];
const WATCH_TIMEOUT_MS = 15000;
const LOCAL_ROOMS_KEY = 'ml_saved_rooms_v1';
const ACTIVE_SERVER_KEY = 'ml_active_server_v1';
const MUTE_SFX_KEY = 'ml_mute_sfx_v1';

const plural = new Intl.PluralRules('pt-BR');
function countLabel(n: number, one: string, other: string) {
  return `${n} ${plural.select(n) === 'one' ? one : other}`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function randomRoomName(): string {
  const words = ['cipo', 'galho', 'cacho', 'selva', 'banana', 'copa'];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.floor(100 + Math.random() * 900)}`;
}

function loadLocalRooms(): SavedRoomRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_ROOMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalRooms(rooms: SavedRoomRecord[]) {
  try {
    localStorage.setItem(LOCAL_ROOMS_KEY, JSON.stringify(rooms.slice(0, 24)));
  } catch {}
}

function relativeTimeLabel(iso: string): string {
  const diffMin = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMin < 2) return 'agora';
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `há ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `há ${diffD} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

function renderChannelKindIcon(kind: ServerChannelRecord['channel_kind']) {
  if (kind === 'game') return <Gamepad2 size={14} />;
  if (kind === 'movie') return <Film size={14} />;
  return <MonitorPlay size={14} />;
}

export function App() {
  // Supabase Auth & Discord-style Servers + Saved Rooms
  const [user, setUser] = useState<User | null>(null);
  const [authTab, setAuthTab] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [guestMode, setGuestMode] = useState(() => localStorage.getItem('ml_guest') === '1');
  const [savedRooms, setSavedRooms] = useState<SavedRoomRecord[]>(() => loadLocalRooms());

  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [activeServerId, setActiveServerId] = useState<string>(
    () => localStorage.getItem(ACTIVE_SERVER_KEY) || 'home'
  );
  const [serverRoster, setServerRoster] = useState<ServerMemberRecord[]>([]);
  const [presenceByKey, setPresenceByKey] = useState<Record<string, ChannelPresenceEntry>>({});

  // Room & Joining
  const [inRoom, setInRoom] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  const [nickname, setNickname] = useState(() => localStorage.getItem('ml_nick') || '');
  const [roomCode, setRoomCode] = useState(() => localStorage.getItem('ml_room') || randomRoomName());
  const [roomDisplayName, setRoomDisplayName] = useState('');
  const [roomServerId, setRoomServerId] = useState<string | null>(null);
  const [roomPassword, setRoomPassword] = useState('');

  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [brokerCount, setBrokerCount] = useState(1);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [copied, setCopied] = useState(false);

  const [quality, setQuality] = useState<StreamQualityConfig>(DEFAULT_QUALITY);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [audioProcesses, setAudioProcesses] = useState<AudioProcessInfo[]>([]);
  const [discordDetected, setDiscordDetected] = useState(false);
  const [audioStatus, setAudioStatus] = useState('');
  const [vuLevel, setVuLevel] = useState(0);

  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [showLocalPreview, setShowLocalPreview] = useState(false);
  const [shareError, setShareError] = useState('');

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [watchTarget, setWatchTarget] = useState<string | null>(null);
  const [watchFailed, setWatchFailed] = useState(false);

  const [volumePct, setVolumePct] = useState(100);
  const [muted, setMuted] = useState(false);
  const [jokeSoundsMuted, setJokeSoundsMuted] = useState(
    () => localStorage.getItem(MUTE_SFX_KEY) === '1'
  );

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'people' | 'quality'>('people');
  const [serverRailOpen, setServerRailOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [mouseIdle, setMouseIdle] = useState(false);

  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [bananas, setBananas] = useState<BananaThrowEvent[]>([]);
  const [latestBanana, setLatestBanana] = useState<BananaThrowEvent | null>(null);
  const [stageHit, setStageHit] = useState(false);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(false);

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckedMsg, setUpdateCheckedMsg] = useState('');
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState('');

  const engineRef = useRef<MacacoWebRtcEngine | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const presenceChanRef = useRef<RealtimeChannel | null>(null);

  const gainCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const bananaComboRef = useRef<{ count: number; lastAt: number }>({ count: 0, lastAt: 0 });
  const lastBananaSendRef = useRef(0);
  const stageHitTimerRef = useRef<number | null>(null);
  const bannerTimerRef = useRef<number | null>(null);

  const jokeSoundsMutedRef = useRef(jokeSoundsMuted);
  jokeSoundsMutedRef.current = jokeSoundsMuted;

  const sidebarTabRef = useRef(sidebarTab);
  sidebarTabRef.current = sidebarTab;
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;

  const currentServer = useMemo(
    () => (activeServerId !== 'home' ? servers.find((s) => s.id === activeServerId) ?? null : null),
    [servers, activeServerId]
  );

  const roomServer = useMemo(
    () => (roomServerId ? servers.find((s) => s.id === roomServerId) ?? null : null),
    [servers, roomServerId]
  );

  const syncAccountData = async (currentUser: User | null) => {
    if (!currentUser) {
      setSavedRooms(loadLocalRooms());
      setServers([]);
      setServerRoster([]);
      setPresenceByKey({});
      return;
    }
    try {
      const [{ nickname: cloudNick, rooms }, srvList] = await Promise.all([
        fetchUserProfileAndRooms(currentUser.id),
        fetchUserServers(),
      ]);
      if (cloudNick) {
        setNickname(cloudNick);
        localStorage.setItem('ml_nick', cloudNick);
      }
      setSavedRooms(rooms);
      setServers(srvList);

      const savedSel = localStorage.getItem(ACTIVE_SERVER_KEY);
      if (savedSel && savedSel !== 'home' && srvList.some((s) => s.id === savedSel)) {
        setActiveServerId(savedSel);
      } else if (srvList.length > 0 && (!savedSel || !srvList.some((s) => s.id === savedSel))) {
        setActiveServerId(srvList[0].id);
        localStorage.setItem(ACTIVE_SERVER_KEY, srvList[0].id);
      } else {
        setActiveServerId('home');
      }
    } catch {}
  };

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user ?? null;
      setUser(u);
      if (u) void syncAccountData(u);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      void syncAccountData(u);
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  // Load server roster when active server changes
  const watchedPresenceServerId = inRoom && roomServerId ? roomServerId : currentServer?.id || null;

  useEffect(() => {
    if (!user || !watchedPresenceServerId) {
      setServerRoster([]);
      setPresenceByKey({});
      return;
    }
    void fetchServerRoster(watchedPresenceServerId).then(setServerRoster);
  }, [user?.id, watchedPresenceServerId]);

  // Realtime Presence per active server so friends see who is online & AO VIVO in each channel
  useEffect(() => {
    if (!user || !watchedPresenceServerId) {
      if (presenceChanRef.current) {
        void supabase.removeChannel(presenceChanRef.current);
        presenceChanRef.current = null;
      }
      return;
    }

    const ch = supabase.channel(`srv-presence:${watchedPresenceServerId}`, {
      config: { presence: { key: user.id } },
    });
    presenceChanRef.current = ch;

    const buildPayload = (): ChannelPresenceEntry => ({
      userId: user.id,
      nickname: nickname.trim() || 'Macaco',
      channelRoomCode: inRoom && roomServerId === watchedPresenceServerId ? roomCode : null,
      isStreaming: inRoom && roomServerId === watchedPresenceServerId && Boolean(localStream),
      updatedAt: Date.now(),
    });

    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<ChannelPresenceEntry>();
      const next: Record<string, ChannelPresenceEntry> = {};
      for (const [key, list] of Object.entries(state)) {
        if (Array.isArray(list) && list.length > 0) {
          next[key] = list[list.length - 1];
        }
      }
      setPresenceByKey(next);
    });

    ch.on('presence', { event: 'join' }, ({ key }) => {
      setServerRoster((prev) => {
        if (prev.some((m) => m.user_id === key)) return prev;
        void fetchServerRoster(watchedPresenceServerId).then(setServerRoster);
        return prev;
      });
    });

    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        void ch.track(buildPayload());
      }
    });

    return () => {
      if (presenceChanRef.current === ch) {
        presenceChanRef.current = null;
      }
      void supabase.removeChannel(ch);
    };
  }, [user?.id, watchedPresenceServerId]);

  // Update presence state whenever channel/streaming state changes without resubscribing
  useEffect(() => {
    const ch = presenceChanRef.current;
    if (!user || !ch || !watchedPresenceServerId) return;
    void ch
      .track({
        userId: user.id,
        nickname: nickname.trim() || 'Macaco',
        channelRoomCode: inRoom && roomServerId === watchedPresenceServerId ? roomCode : null,
        isStreaming: inRoom && roomServerId === watchedPresenceServerId && Boolean(localStream),
        updatedAt: Date.now(),
      })
      .catch(() => {});
  }, [user?.id, nickname, inRoom, roomCode, roomServerId, localStream, watchedPresenceServerId]);

  useEffect(() => {
    nativeBridge.init();
    nativeBridge.onAudioLevel((lvl) => setVuLevel(lvl));
    nativeBridge.onAudioStatus((msg) => setAudioStatus(msg));
    nativeBridge.onFullscreenChanged((fs) => {
      setIsFullscreen(fs);
      if (fs) setSidebarOpen(false);
    });

    const runUpdateCheck = () => {
      void nativeBridge.checkUpdate().then((res) => {
        if (res && res.available && res.downloadUrl) {
          setUpdateInfo(res);
          setUpdateCheckedMsg('');
        }
      });
    };

    runUpdateCheck();
    const updateTimer = window.setInterval(runUpdateCheck, 5 * 60 * 1000);

    const stopCaptureOnExit = () => {
      void engineRef.current?.stopScreenShare(false);
    };
    window.addEventListener('beforeunload', stopCaptureOnExit);

    return () => {
      window.clearInterval(updateTimer);
      window.removeEventListener('beforeunload', stopCaptureOnExit);
      void engineRef.current?.stopScreenShare(false);
      nativeBridge.onAudioLevel(null);
      nativeBridge.onAudioStatus(null);
      nativeBridge.onFullscreenChanged(null);
    };
  }, []);

  const refreshAudioApps = async () => {
    try {
      const [info, mons] = await Promise.all([
        nativeBridge.listAudioApps(),
        nativeBridge.listMonitors(),
      ]);
      setAudioProcesses(info.processes);
      setDiscordDetected(info.discordRunning);
      setMonitors(mons);
      if (quality.audioMode === 'include-process' && quality.targetPid === 0 && info.processes.length > 0) {
        setQuality((q) => ({ ...q, targetPid: info.processes[0].pid }));
      }
    } catch {}
  };

  useEffect(() => {
    if (inRoom) void refreshAudioApps();
  }, [inRoom]);

  const displayStream = useMemo(() => {
    if (remoteStream) return remoteStream;
    if (localStream && showLocalPreview) return localStream;
    return null;
  }, [remoteStream, localStream, showLocalPreview]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = displayStream;
    if (!displayStream) return;

    if (remoteStream) {
      el.muted = muted;
      el.volume = Math.min(1, volumePct / 100);
    } else {
      el.muted = true;
    }
    el.play().catch(() => {});
  }, [displayStream, remoteStream]);

  useEffect(() => {
    const el = videoRef.current;
    if (el && remoteStream) {
      el.muted = muted;
      el.volume = Math.min(1, volumePct / 100);
    }
  }, [volumePct, muted, remoteStream]);

  useEffect(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {}
      sourceNodeRef.current = null;
    }
    if (!remoteStream || remoteStream.getAudioTracks().length === 0 || volumePct <= 100 || muted) {
      return;
    }

    try {
      if (!gainCtxRef.current || gainCtxRef.current.state === 'closed') {
        gainCtxRef.current = new AudioContext({ latencyHint: 'interactive' });
      }
      const ctx = gainCtxRef.current;
      if (ctx.state === 'suspended') void ctx.resume();
      const source = ctx.createMediaStreamSource(remoteStream);
      const gain = gainNodeRef.current || ctx.createGain();
      gain.gain.value = (volumePct - 100) / 100;
      source.connect(gain);
      gain.connect(ctx.destination);
      sourceNodeRef.current = source;
      gainNodeRef.current = gain;
    } catch {}
  }, [remoteStream, volumePct, muted]);

  useEffect(() => {
    setWatchFailed(false);
    if (!watchTarget || remoteStream) return;
    const t = window.setTimeout(() => setWatchFailed(true), WATCH_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [watchTarget, remoteStream]);

  const handleMouseMove = () => {
    setMouseIdle(false);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    if ((isFullscreen || !sidebarOpen) && remoteStream) {
      idleTimerRef.current = window.setTimeout(() => setMouseIdle(true), 2500);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (!nativeBridge.isDesktopApp) {
        if (e.key === 'F11') {
          e.preventDefault();
          void toggleFullscreen();
          return;
        }
        if (e.key === 'Escape' && isFullscreen) {
          void toggleFullscreen(false);
          return;
        }
      }

      if (inRoom && !isTyping && !shareModalOpen && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        void throwBanana();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inRoom, isFullscreen, shareModalOpen]);

  const pushReaction = (nick: string, emoji: string) => {
    const id = crypto.randomUUID();
    setReactions((prev) => [...prev.slice(-5), { id, nick, emoji }]);
    window.setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), 3100);
  };

  const handleIncomingBanana = (ev: BananaThrowEvent) => {
    playBananaSound(ev.combo, jokeSoundsMutedRef.current);
    setBananas((prev) => [...prev.slice(-13), ev]);
    setLatestBanana(ev);
    setStageHit(false);
    requestAnimationFrame(() => setStageHit(true));

    if (stageHitTimerRef.current) window.clearTimeout(stageHitTimerRef.current);
    stageHitTimerRef.current = window.setTimeout(() => setStageHit(false), 240);

    if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => setLatestBanana(null), 2250);

    window.setTimeout(() => {
      setBananas((prev) => prev.filter((item) => item.id !== ev.id));
    }, 2550);
  };

  const throwBanana = async () => {
    const now = Date.now();
    if (now - lastBananaSendRef.current < 180) return;
    lastBananaSendRef.current = now;

    if (now - bananaComboRef.current.lastAt < 3200) {
      bananaComboRef.current.count += 1;
    } else {
      bananaComboRef.current.count = 1;
    }
    bananaComboRef.current.lastAt = now;

    const fromLeft = Math.random() > 0.5;
    const ev: BananaThrowEvent = {
      id: crypto.randomUUID(),
      nick: nickname.trim() || 'Você',
      targetX: 18 + Math.random() * 64,
      targetY: 18 + Math.random() * 54,
      startX: fromLeft ? -8 : 108,
      startY: 85 + Math.random() * 18,
      rotation: Math.round(-26 + Math.random() * 52),
      combo: bananaComboRef.current.count,
      ts: now,
    };

    handleIncomingBanana(ev);
    await engineRef.current?.sendBanana(ev);
  };

  const handleIncomingChat = (msg: ChatMessage) => {
    setChatMessages((prev) => [...prev.slice(-99), msg]);
    if (!sidebarOpenRef.current || sidebarTabRef.current !== 'people') {
      setUnreadChat(true);
    }
    playChatPop(jokeSoundsMutedRef.current);
  };

  const sendChat = async (text: string) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      senderId: engineRef.current?.selfId || 'self',
      nickname: nickname.trim() || 'Você',
      text,
      ts: Date.now(),
      self: true,
    };
    setChatMessages((prev) => [...prev.slice(-99), msg]);
    await engineRef.current?.sendChatMessage(msg);
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = authEmail.trim();
    if (!email || !authPassword) return;

    setAuthLoading(true);
    setAuthError('');
    setAuthSuccess('');

    try {
      if (authTab === 'signup') {
        const cleanNick = nickname.trim() || email.split('@')[0] || 'Macaco';
        const { data, error } = await supabase.auth.signUp({
          email,
          password: authPassword,
          options: {
            data: { nickname: cleanNick },
            emailRedirectTo: CONFIRM_REDIRECT_URL,
          },
        });
        if (error) throw error;
        setNickname(cleanNick);
        localStorage.setItem('ml_nick', cleanNick);

        if (data.session) {
          setGuestMode(false);
          localStorage.removeItem('ml_guest');
        } else {
          setAuthSuccess('Conta criada! Confirme pelo link no seu e-mail e depois faça login.');
          setAuthTab('login');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password: authPassword,
        });
        if (error) throw error;
        setGuestMode(false);
        localStorage.removeItem('ml_guest');
      }
    } catch (err: any) {
      setAuthError(err?.message || 'Não foi possível autenticar.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOutAccount = async () => {
    await supabase.auth.signOut();
    setAuthEmail('');
    setAuthPassword('');
    setGuestMode(false);
    localStorage.removeItem('ml_guest');
    setActiveServerId('home');
  };

  const recordRoomHistory = async (code: string, pass: string, label?: string) => {
    const now = new Date().toISOString();
    const existing = savedRooms.find((r) => r.room_code === code);
    const entry: SavedRoomRecord = {
      room_code: code,
      room_label: label || existing?.room_label || code,
      room_password: pass,
      is_pinned: existing?.is_pinned ?? false,
      last_joined_at: now,
    };

    const next = [entry, ...savedRooms.filter((r) => r.room_code !== code)].sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return new Date(b.last_joined_at).getTime() - new Date(a.last_joined_at).getTime();
    });
    setSavedRooms(next);
    saveLocalRooms(next);

    if (user) {
      await upsertSavedRoom(user.id, entry);
      await updateNickname(user.id, nickname);
    }
  };

  const teardownCurrentRoom = async () => {
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {}
      sourceNodeRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => {
        try {
          t.enabled = false;
          t.stop();
        } catch {}
      });
    }

    const engine = engineRef.current;
    engineRef.current = null;

    setShareModalOpen(false);
    setLocalStream(null);
    setShowLocalPreview(false);
    setRemoteStream(null);
    setWatchTarget(null);
    setStats(null);
    setPeers([]);
    setChatMessages([]);
    setBananas([]);
    setLatestBanana(null);
    setUnreadChat(false);

    if (engine) {
      try {
        await engine.leaveRoom();
      } catch {}
    }
  };

  const enterRoom = async (
    targetCode: string,
    targetPass: string,
    displayLabel?: string,
    serverId: string | null = null
  ) => {
    const room = targetCode.trim();
    if (!room) return;

    const nick = nickname.trim() || `Macaco ${Math.floor(10 + Math.random() * 89)}`;
    setNickname(nick);
    setRoomCode(room);
    setRoomDisplayName(displayLabel || room);
    setRoomServerId(serverId);
    setRoomPassword(targetPass);
    localStorage.setItem('ml_nick', nick);
    if (!serverId) {
      localStorage.setItem('ml_room', room);
    }

    setJoining(true);
    setJoinError('');

    try {
      const engine = new MacacoWebRtcEngine(
        {
          onPeersUpdated: setPeers,
          onRemoteStream: (_id, stream) => setRemoteStream(stream),
          onWatchTargetChanged: setWatchTarget,
          onLocalStreamChanged: (stream, status) => {
            setLocalStream(stream);
            setAudioStatus(status);
          },
          onStatsUpdated: setStats,
          onBrokerStatus: setBrokerCount,
          onReaction: pushReaction,
          onBanana: handleIncomingBanana,
          onChatMessage: handleIncomingChat,
        },
        quality
      );
      engineRef.current = engine;
      await engine.joinRoom(nick, room, targetPass);
      setInRoom(true);
      if (!serverId) {
        void recordRoomHistory(room, targetPass, displayLabel);
      } else if (user) {
        void updateNickname(user.id, nick);
      }
    } catch (err: any) {
      setJoinError(err?.message || 'Não foi possível entrar na sala.');
    } finally {
      setJoining(false);
    }
  };

  const handleSwitchChannel = async (ch: ServerChannelRecord, srv: ServerRecord) => {
    if (joining || ch.room_code === roomCode) return;
    await teardownCurrentRoom();
    await enterRoom(ch.room_code, '', ch.name, srv.id);
  };

  const handleJoinRoomForm = (e: React.FormEvent) => {
    e.preventDefault();
    void enterRoom(roomCode, roomPassword);
  };

  const handleTogglePin = async (room: SavedRoomRecord) => {
    const nextPin = !room.is_pinned;
    const next = savedRooms
      .map((r) => (r.room_code === room.room_code ? { ...r, is_pinned: nextPin } : r))
      .sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
        return new Date(b.last_joined_at).getTime() - new Date(a.last_joined_at).getTime();
      });
    setSavedRooms(next);
    saveLocalRooms(next);
    if (user) await toggleRoomPin(user.id, room.room_code, nextPin);
  };

  const handleRemoveRoom = async (roomCodeToDelete: string) => {
    const next = savedRooms.filter((r) => r.room_code !== roomCodeToDelete);
    setSavedRooms(next);
    saveLocalRooms(next);
    if (user) await removeSavedRoom(user.id, roomCodeToDelete);
  };

  const handleSelectServer = (id: string) => {
    setActiveServerId(id);
    localStorage.setItem(ACTIVE_SERVER_KEY, id);
  };

  const handleCreateServer = async (name: string, accentColor: string) => {
    const created = await createServerWithChannels(name, accentColor);
    setServers((prev) => [...prev, created]);
    handleSelectServer(created.id);
  };

  const handleJoinByInvite = async (inviteCode: string) => {
    const joined = await joinServerByInvite(inviteCode);
    const all = await fetchUserServers();
    setServers(all);
    handleSelectServer(joined.id);
  };

  const handleCreateChannel = async (
    serverId: string,
    name: string,
    kind: 'stream' | 'game' | 'movie'
  ) => {
    if (!user) return;
    const srv = servers.find((s) => s.id === serverId);
    const ch = await createServerChannel(
      serverId,
      name,
      kind,
      user.id,
      srv ? srv.channels.length : 0
    );
    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, channels: [...s.channels, ch] } : s))
    );
  };

  const handleDeleteChannel = async (ch: ServerChannelRecord) => {
    await deleteServerChannel(ch.id);
    setServers((prev) =>
      prev.map((s) =>
        s.id === ch.server_id
          ? { ...s, channels: s.channels.filter((c) => c.id !== ch.id) }
          : s
      )
    );
  };

  const handleLeaveOrDeleteServer = async (srv: ServerRecord) => {
    if (!user) return;
    await leaveOrDeleteServer(srv, user.id);
    const remaining = servers.filter((s) => s.id !== srv.id);
    setServers(remaining);
    handleSelectServer(remaining[0]?.id || 'home');
  };

  const handleManualUpdateCheck = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    setUpdateCheckedMsg('');
    const res = await nativeBridge.checkUpdate();
    setCheckingUpdate(false);
    if (res && res.available && res.downloadUrl) {
      setUpdateInfo(res);
      setUpdateCheckedMsg('');
    } else {
      setUpdateCheckedMsg(
        res ? `Já está na última versão (v${res.currentVersion}).` : 'Não foi possível verificar agora.'
      );
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo?.downloadUrl || updating) return;
    setUpdating(true);
    setUpdateError('');
    try {
      await engineRef.current?.stopScreenShare(false);
      await nativeBridge.installUpdate(updateInfo.downloadUrl);
    } catch (err: any) {
      setUpdateError(err?.message || 'Não foi possível concluir a atualização.');
      setUpdating(false);
    }
  };

  const handleLeaveRoom = async () => {
    await teardownCurrentRoom();
    setRoomServerId(null);
    setInRoom(false);
    try {
      if (isFullscreen) await toggleFullscreen(false);
    } catch {}
  };

  const startShareWithConfig = async (cfg: StreamQualityConfig) => {
    if (!engineRef.current) return;
    setQuality(cfg);
    setShareError('');
    try {
      await engineRef.current.startScreenShare(cfg);
    } catch (err: any) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setShareError(err?.message || 'Não foi possível capturar a tela.');
      }
      throw err;
    }
  };

  const handleStopShare = async () => {
    await engineRef.current?.stopScreenShare();
    setShowLocalPreview(false);
  };

  const applyQualityChange = async (patch: Partial<StreamQualityConfig>) => {
    const sourceChanged =
      (patch.captureSource && patch.captureSource !== quality.captureSource) ||
      (patch.monitorIndex !== undefined && patch.monitorIndex !== quality.monitorIndex);
    const next = { ...quality, ...patch };
    setQuality(next);
    if (engineRef.current && localStream) {
      if (sourceChanged) {
        await engineRef.current.startScreenShare(next);
      } else {
        const label = await engineRef.current.updateLiveQuality(next);
        if (label) setAudioStatus(label);
      }
    }
  };

  const toggleFullscreen = async (force?: boolean) => {
    const next = typeof force === 'boolean' ? force : !isFullscreen;
    setIsFullscreen(next);
    if (next) setSidebarOpen(false);
    await nativeBridge.setFullscreen(next);
  };

  const toggleAlwaysOnTop = async () => {
    const next = await nativeBridge.setAlwaysOnTop(!alwaysOnTop);
    setAlwaysOnTop(next);
  };

  const toggleJokeSoundsMuted = () => {
    setJokeSoundsMuted((prev) => {
      const next = !prev;
      localStorage.setItem(MUTE_SFX_KEY, next ? '1' : '0');
      return next;
    });
  };

  const takeSnapshot = () => {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0 || v.videoHeight === 0) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `macacolive-${Date.now()}.png`;
      a.click();
    } catch {}
  };

  const copyInvite = async () => {
    if (roomServer) {
      await navigator.clipboard.writeText(
        `Entre no servidor "${roomServer.name}" (#${roomDisplayName}) no MacacoLive!\nCódigo do convite: ${roomServer.invite_code}`
      );
    } else {
      const lines = [`Sala do MacacoLive: ${roomCode.trim()}`];
      if (roomPassword.trim()) lines.push(`Senha: ${roomPassword.trim()}`);
      await navigator.clipboard.writeText(lines.join('\n'));
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const sendReaction = async (emoji: string) => {
    pushReaction('Você', emoji);
    await engineRef.current?.sendReaction(emoji);
  };

  /* ---------------- Lobby / Discord Hub ---------------- */
  if (!inRoom) {
    const showAuthPanel = !user && !guestMode;

    return (
      <div className="lobby view-enter">
        <header className="lobby-topbar">
          <div className="wordmark">
            <LogoMark size={30} title="MacacoLive" />
            <span className="wordmark-text">MacacoLive</span>
          </div>

          <div className="lobby-topbar-right">
            {updateInfo?.available && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={updating}
                onClick={() => void handleInstallUpdate()}
              >
                {updating ? (
                  <>
                    <LoaderCircle size={14} className="spin" /> Atualizando...
                  </>
                ) : (
                  <>
                    <Download size={14} /> Atualizar v{updateInfo.latestVersion}
                  </>
                )}
              </button>
            )}

            {user ? (
              <div className="account-pill">
                <span className="avatar self" style={{ width: 26, height: 26, fontSize: 11 }}>
                  {initials(nickname || user.email || 'M')}
                </span>
                <span className="truncate" style={{ maxWidth: 160 }}>
                  {nickname || user.email}
                </span>
                <button
                  type="button"
                  className="btn btn-icon"
                  style={{ width: 26, height: 26 }}
                  onClick={() => void handleSignOutAccount()}
                  title="Sair da conta"
                  aria-label="Sair da conta"
                >
                  <LogOut size={14} />
                </button>
              </div>
            ) : guestMode ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setGuestMode(false);
                  localStorage.removeItem('ml_guest');
                }}
              >
                <UserCheck size={14} /> Entrar com conta
              </button>
            ) : null}
          </div>
        </header>

        <main className="lobby-content">
          {user ? (
            <ServerLobby
              user={user}
              nickname={nickname}
              onNicknameChange={(n) => {
                setNickname(n);
                localStorage.setItem('ml_nick', n);
              }}
              servers={servers}
              activeServerId={activeServerId}
              onSelectServer={handleSelectServer}
              serverRoster={serverRoster}
              presenceByKey={presenceByKey}
              savedRooms={savedRooms}
              roomCode={roomCode}
              onRoomCodeChange={setRoomCode}
              roomPassword={roomPassword}
              onRoomPasswordChange={setRoomPassword}
              onRandomRoom={() => setRoomCode(randomRoomName())}
              joining={joining}
              joinError={joinError}
              onJoinChannel={(ch, srv) => void enterRoom(ch.room_code, '', ch.name, srv.id)}
              onJoinQuickRoom={(code, pass, label) => void enterRoom(code, pass, label, null)}
              onTogglePin={(r) => void handleTogglePin(r)}
              onRemoveRoom={(code) => void handleRemoveRoom(code)}
              onCreateServer={handleCreateServer}
              onJoinByInvite={handleJoinByInvite}
              onCreateChannel={handleCreateChannel}
              onDeleteChannel={handleDeleteChannel}
              onLeaveOrDeleteServer={handleLeaveOrDeleteServer}
              relativeTimeLabel={relativeTimeLabel}
            />
          ) : (
            <div className="lobby-grid">
              {showAuthPanel ? (
                <form className="lobby-card view-enter" onSubmit={handleAuthSubmit}>
                  <header className="lobby-head">
                    <h1>Sua conta na tropa</h1>
                    <p>Entre para montar servidores estilo Discord e salvar suas salas.</p>
                  </header>

                  <div className="segmented" role="tablist">
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={authTab === 'login'}
                      onClick={() => {
                        setAuthTab('login');
                        setAuthError('');
                      }}
                    >
                      Entrar
                    </button>
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={authTab === 'signup'}
                      onClick={() => {
                        setAuthTab('signup');
                        setAuthError('');
                      }}
                    >
                      Criar conta
                    </button>
                  </div>

                  <div className="lobby-fields">
                    {authTab === 'signup' && (
                      <label className="field">
                        <span className="field-label">Apelido</span>
                        <input
                          className="input"
                          placeholder="Como a turma te chama"
                          value={nickname}
                          onChange={(e) => setNickname(e.target.value)}
                          maxLength={40}
                          required
                        />
                      </label>
                    )}

                    <label className="field">
                      <span className="field-label">E-mail</span>
                      <input
                        type="email"
                        className="input"
                        placeholder="voce@exemplo.com"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        required
                        autoFocus
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Senha</span>
                      <input
                        type="password"
                        className="input"
                        placeholder="Mínimo 6 caracteres"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        minLength={6}
                        required
                      />
                    </label>
                  </div>

                  {authError && (
                    <div className="inline-error" role="alert">
                      <TriangleAlert size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{authError}</span>
                    </div>
                  )}

                  {authSuccess && (
                    <div className="inline-ok" role="status">
                      <Check size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{authSuccess}</span>
                    </div>
                  )}

                  <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={authLoading}>
                    {authLoading ? (
                      <>
                        <LoaderCircle size={16} className="spin" /> Aguarde
                      </>
                    ) : authTab === 'signup' ? (
                      'Criar conta'
                    ) : (
                      'Entrar'
                    )}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary btn-block"
                    onClick={() => {
                      setGuestMode(true);
                      localStorage.setItem('ml_guest', '1');
                    }}
                  >
                    Continuar sem conta
                  </button>
                </form>
              ) : (
                <form className="lobby-card view-enter" onSubmit={handleJoinRoomForm}>
                  <header className="lobby-head">
                    <h1>Entrar em uma sala</h1>
                    <p>Crie ou entre numa sala para transmitir tela e som direto aos amigos.</p>
                  </header>

                  <div className="lobby-fields">
                    <label className="field">
                      <span className="field-label">Apelido</span>
                      <input
                        className="input"
                        placeholder="Como a turma te chama"
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                        maxLength={60}
                        autoFocus
                      />
                    </label>

                    <div className="field">
                      <label className="field-label" htmlFor="room">
                        Sala
                        <span className="field-hint">Todos entram com o mesmo nome</span>
                      </label>
                      <div className="input-row">
                        <input
                          id="room"
                          className="input"
                          value={roomCode}
                          onChange={(e) => setRoomCode(e.target.value)}
                          maxLength={48}
                          required
                        />
                        <button
                          type="button"
                          className="btn btn-secondary btn-icon"
                          style={{ width: 40, height: 40 }}
                          title="Sortear outro nome"
                          aria-label="Sortear outro nome de sala"
                          onClick={() => setRoomCode(randomRoomName())}
                        >
                          <Shuffle size={16} />
                        </button>
                      </div>
                    </div>

                    <label className="field">
                      <span className="field-label">
                        Senha
                        <span className="field-hint">Opcional</span>
                      </span>
                      <input
                        type="password"
                        className="input"
                        placeholder="Sem senha, entra quem souber o nome"
                        value={roomPassword}
                        onChange={(e) => setRoomPassword(e.target.value)}
                      />
                    </label>
                  </div>

                  {joinError && (
                    <div className="inline-error" role="alert">
                      <TriangleAlert size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{joinError}</span>
                    </div>
                  )}

                  <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={joining}>
                    {joining ? (
                      <>
                        <LoaderCircle size={16} className="spin" /> Conectando
                      </>
                    ) : (
                      'Entrar na sala'
                    )}
                  </button>
                </form>
              )}

              <section className="lobby-card">
                <header className="lobby-head">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h2>Suas salas</h2>
                    <span className="field-hint num">Salvo neste PC</span>
                  </div>
                  <p>Entre na sua conta para sincronizar servidores e salas em qualquer PC.</p>
                </header>

                {savedRooms.length === 0 ? (
                  <div className="empty-note">
                    Nenhuma sala salva ainda. Assim que você entrar em uma sala, ela fica aqui no seu histórico.
                  </div>
                ) : (
                  <div className="saved-rooms-list">
                    {savedRooms.map((r, idx) => (
                      <div
                        key={r.room_code}
                        className="room-item item-enter"
                        style={{ animationDelay: `${Math.min(idx * 35, 180)}ms` }}
                      >
                        <button
                          type="button"
                          className="room-item-main"
                          disabled={joining}
                          onClick={() => void enterRoom(r.room_code, r.room_password || '', r.room_label)}
                        >
                          <span className="room-item-title">
                            <span className="truncate">{r.room_label || r.room_code}</span>
                            {r.room_password && <Lock size={12} color="var(--text-3)" />}
                          </span>
                          <span className="room-item-sub num">
                            {r.is_pinned ? 'Fixada · ' : ''}
                            {relativeTimeLabel(r.last_joined_at)}
                          </span>
                        </button>

                        <div className="room-item-actions">
                          <button
                            type="button"
                            className="btn btn-icon"
                            style={{ width: 30, height: 30 }}
                            onClick={() => void handleTogglePin(r)}
                            title={r.is_pinned ? 'Desafixar' : 'Fixar no topo'}
                            aria-label={r.is_pinned ? 'Desafixar sala' : 'Fixar sala'}
                          >
                            {r.is_pinned ? (
                              <PinOff size={14} color="var(--banana)" />
                            ) : (
                              <Pin size={14} />
                            )}
                          </button>
                          <button
                            type="button"
                            className="btn btn-icon"
                            style={{ width: 30, height: 30 }}
                            onClick={() => void handleRemoveRoom(r.room_code)}
                            title="Remover do histórico"
                            aria-label="Remover sala do histórico"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {showAuthPanel && (
                  <div className="lobby-fields" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }}>
                    <span className="field-hint">
                      Quer só entrar rápido? Clique em <strong>Continuar sem conta</strong> ao lado ou escolha uma sala salva acima.
                    </span>
                  </div>
                )}
              </section>
            </div>
          )}

          <div className={`lobby-foot ${user ? 'wide' : ''}`}>
            <span>
              Vídeo direto P2P · v{APP_VERSION}
              {updateCheckedMsg ? ` · ${updateCheckedMsg}` : ''}
            </span>
            {nativeBridge.isDesktopApp && !updateInfo?.available && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                disabled={checkingUpdate}
                onClick={() => void handleManualUpdateCheck()}
              >
                {checkingUpdate ? 'Checando...' : 'Checar atualização'}
              </button>
            )}
          </div>
        </main>
      </div>
    );
  }

  /* ---------------- Room ---------------- */
  const watchingPeer = peers.find((p) => p.peerId === watchTarget);
  const streamingPeers = peers.filter((p) => p.isStreaming);
  const chromeHidden = mouseIdle && (isFullscreen || !sidebarOpen) && Boolean(remoteStream);
  const disconnected = brokerCount === 0;
  const onlineEntries = Object.values(presenceByKey);

  const renderStage = () => {
    if (displayStream) {
      return <video ref={videoRef} className="stage-video" playsInline autoPlay />;
    }

    if (localStream) {
      return (
        <div className="stage-state">
          <div className="stage-icon live">
            <Radio size={22} />
          </div>
          <h2>Você está transmitindo</h2>
          <p>
            {peers.length > 0
              ? `${countLabel(peers.length, 'pessoa recebe', 'pessoas recebem')} sua tela. A prévia fica desligada para poupar a placa de vídeo.`
              : 'Ninguém entrou ainda. Mande o convite da sala ou canal para os amigos.'}
          </p>
          {audioStatus && (
            <p className="note" style={{ justifyContent: 'center' }}>
              <ShieldCheck size={14} />
              {audioStatus}
            </p>
          )}
          <div className="stage-actions" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setShowLocalPreview(true)}>
              <Eye size={15} /> Ver minha tela
            </button>
            <button
              type="button"
              className="btn btn-banana"
              style={{ height: 36 }}
              onClick={() => void throwBanana()}
              title="Atalho: tecla B"
            >
              <BananaIcon size={16} /> Tacar banana
            </button>
            <button type="button" className="btn btn-danger" onClick={handleStopShare}>
              <Square size={13} /> Parar transmissão
            </button>
          </div>
        </div>
      );
    }

    if (watchTarget && !remoteStream) {
      const name = watchingPeer?.nickname || 'amigo';
      if (watchFailed) {
        return (
          <div className="stage-state" role="alert">
            <div className="stage-icon error">
              <TriangleAlert size={22} />
            </div>
            <h2>Não conectou na tela de {name}</h2>
            <p>
              A rede de um de vocês pode estar bloqueando conexão direta. Tentar de novo costuma resolver. Se repetir, usem Radmin VPN ou Tailscale.
            </p>
            <div className="stage-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void engineRef.current?.watchStreamer(watchTarget)}
              >
                <RefreshCw size={15} /> Tentar de novo
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="stage-state" aria-live="polite">
          <div className="stage-icon">
            <LoaderCircle size={22} className="spin" />
          </div>
          <h2 className="truncate" style={{ maxWidth: '100%' }}>
            Conectando na tela de {name}
          </h2>
          <p>Leva alguns segundos.</p>
        </div>
      );
    }

    return (
      <div className="stage-state">
        <div className="stage-icon">
          <Tv size={22} />
        </div>
        <h2>Ninguém está transmitindo</h2>
        <p>Quando alguém começar, a tela aparece aqui sozinha.</p>
        {shareError && (
          <div className="inline-error" role="alert" style={{ textAlign: 'left' }}>
            <TriangleAlert size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{shareError}</span>
          </div>
        )}
        <button type="button" className="btn btn-primary btn-lg" onClick={() => setShareModalOpen(true)}>
          <MonitorUp size={16} /> Transmitir tela
        </button>
      </div>
    );
  };

  return (
    <div
      className={`room view-enter ${chromeHidden ? 'chrome-hidden cursor-hidden' : ''}`}
      onMouseMove={handleMouseMove}
    >
      <header className="topbar">
        {roomServer && !isFullscreen && (
          <button
            type="button"
            className="btn btn-icon"
            style={{ width: 32, height: 32 }}
            onClick={() => setServerRailOpen((v) => !v)}
            title={serverRailOpen ? 'Esconder canais' : 'Mostrar canais do servidor'}
            aria-label="Alternar lista de canais"
          >
            {serverRailOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        )}

        <LogoMark size={26} title="MacacoLive" />

        <div className="topbar-room">
          <span
            className={`conn-dot ${disconnected ? 'off' : ''}`}
            title={disconnected ? 'Sem conexão com a sala' : 'Conectado à sala'}
          />
          <span className="topbar-room-name truncate" title={roomServer ? `${roomServer.name} / #${roomDisplayName}` : roomCode}>
            {roomServer ? `${roomServer.name} · #${roomDisplayName}` : roomCode}
          </span>
          <button
            type="button"
            className="btn btn-icon"
            style={{ width: 28, height: 28 }}
            onClick={copyInvite}
            title={roomServer ? 'Copiar convite do servidor' : 'Copiar convite da sala'}
            aria-label="Copiar convite"
          >
            {copied ? <Check size={14} color="var(--leaf)" /> : <Copy size={14} />}
          </button>
        </div>

        <div
          className="topbar-stats num"
          title={
            stats
              ? `Codec: ${stats.codec} · Rota: ${stats.routeType}${
                  stats.limitation && stats.limitation !== 'none'
                    ? ` · Limite: ${stats.limitation}`
                    : ''
                }`
              : undefined
          }
        >
          {stats && (
            <>
              <span>
                <strong>{stats.height > 0 ? `${stats.height}p` : '…'}</strong>
              </span>
              <span>
                <strong>{stats.fps}</strong> fps
              </span>
              <span>
                <strong>{stats.bitrateMbps.toFixed(1)}</strong> Mbps
              </span>
              <span>
                <strong>{stats.rttMs}</strong> ms
              </span>
              {stats.packetLossPct > 1 && (
                <span style={{ color: 'var(--danger)' }}>
                  <strong style={{ color: 'inherit' }}>{stats.packetLossPct}%</strong> perda
                </span>
              )}
            </>
          )}
        </div>

        <div className="topbar-actions">
          {updateInfo?.available && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={updating}
              onClick={() => void handleInstallUpdate()}
              title={
                updateError
                  ? updateError
                  : `Nova versão v${updateInfo.latestVersion} disponível. Clique para atualizar e reabrir.`
              }
            >
              {updating ? (
                <>
                  <LoaderCircle size={14} className="spin" /> Atualizando...
                </>
              ) : (
                <>
                  <Download size={14} /> Atualizar v{updateInfo.latestVersion}
                </>
              )}
            </button>
          )}

          <button
            type="button"
            className="btn btn-banana"
            style={{ marginRight: 6 }}
            onClick={() => void throwBanana()}
            title="Tacar banana na tela de todo mundo (Atalho: B)"
          >
            <BananaIcon size={15} /> Tacar banana
          </button>

          {localStream ? (
            <button type="button" className="btn btn-danger" onClick={handleStopShare}>
              <Square size={13} /> Parar
            </button>
          ) : (displayStream || watchTarget) ? (
            <button type="button" className="btn btn-primary" onClick={() => setShareModalOpen(true)}>
              <MonitorUp size={15} /> Transmitir
            </button>
          ) : null}

          {nativeBridge.isDesktopApp && (
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => void toggleAlwaysOnTop()}
              title={alwaysOnTop ? 'Desafixar do topo' : 'Fixar janela no topo (Mini-player)'}
              aria-label="Fixar janela no topo"
            >
              {alwaysOnTop ? <PinOff size={16} color="var(--banana)" /> : <Pin size={16} />}
            </button>
          )}

          <button
            type="button"
            className="btn btn-icon"
            onClick={toggleJokeSoundsMuted}
            title={jokeSoundsMuted ? 'Ativar som da banana e chat' : 'Silenciar som da banana e chat'}
            aria-label="Alternar sons de efeito"
          >
            {jokeSoundsMuted ? <BellOff size={16} /> : <Bell size={16} />}
          </button>

          <button
            type="button"
            className="btn btn-icon"
            onClick={() => {
              const next = !sidebarOpen;
              setSidebarOpen(next);
              if (next && sidebarTab === 'people') setUnreadChat(false);
            }}
            title={sidebarOpen ? 'Esconder painel' : 'Mostrar painel'}
            aria-label={sidebarOpen ? 'Esconder painel' : 'Mostrar painel'}
          >
            {sidebarOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={handleLeaveRoom}
            title="Sair da sala"
            aria-label="Sair da sala"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {disconnected && (
        <div className="banner" role="status">
          <WifiOff size={14} /> Sem conexão com a sala. Tentando de novo. Quem já está assistindo continua.
        </div>
      )}

      {updateError && (
        <div className="banner" role="alert">
          <TriangleAlert size={14} /> {updateError}
        </div>
      )}

      <div className="room-body">
        {/* Optional Left Server Channels Strip when inside a Discord Server */}
        {roomServer && serverRailOpen && !isFullscreen && !chromeHidden && (
          <aside className="room-channel-rail" aria-label="Canais do servidor">
            <div className="rail-head">
              <span
                className="server-color-dot"
                style={{ background: roomServer.accent_color }}
              />
              <strong className="truncate">{roomServer.name}</strong>
            </div>

            <div className="rail-channels">
              {roomServer.channels.map((ch) => {
                const isActive = ch.room_code === roomCode;
                const occ = onlineEntries.filter((o) => o.channelRoomCode === ch.room_code);
                const chLive = occ.some((o) => o.isStreaming);
                return (
                  <button
                    key={ch.id}
                    type="button"
                    className={`rail-channel-btn ${isActive ? 'active' : ''}`}
                    disabled={joining}
                    onClick={() => void handleSwitchChannel(ch, roomServer)}
                  >
                    {renderChannelKindIcon(ch.channel_kind)}
                    <span className="truncate">{ch.name}</span>
                    {occ.length > 0 && (
                      <span className={`rail-occ-badge num ${chLive ? 'live' : ''}`}>
                        {chLive ? 'AO VIVO' : occ.length}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        <main
          className={`stage ${stageHit ? 'stage-banana-hit' : ''}`}
          onDoubleClick={() => displayStream && void toggleFullscreen()}
        >
          {renderStage()}

          {/* Cartoon Banana Flight + Splat Overlay (visible for BOTH broadcaster & viewers) */}
          <BananaOverlay bananas={bananas} latestThrow={latestBanana} />

          <div className="reactions" aria-live="polite">
            {reactions.map((r) => (
              <div key={r.id} className="reaction-toast">
                <span className="emoji">{r.emoji}</span>
                <span className="truncate">{r.nick}</span>
              </div>
            ))}
          </div>

          {displayStream && (
            <div className="hud" onDoubleClick={(e) => e.stopPropagation()}>
              {remoteStream && watchingPeer && (
                <span className="hud-who truncate" title={watchingPeer.nickname}>
                  {watchingPeer.nickname}
                </span>
              )}
              {!remoteStream && <span className="hud-who">Sua tela</span>}

              {remoteStream && (
                <>
                  <span className="hud-sep" />
                  <div className="hud-volume">
                    <button
                      type="button"
                      className="btn btn-icon"
                      style={{ width: 32, height: 32 }}
                      onClick={() => setMuted((m) => !m)}
                      aria-label={muted ? 'Ativar som' : 'Silenciar'}
                    >
                      {muted || volumePct === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                    <input
                      type="range"
                      className="range"
                      min={0}
                      max={200}
                      step={5}
                      value={muted ? 0 : volumePct}
                      onChange={(e) => {
                        setMuted(false);
                        setVolumePct(Number(e.target.value));
                      }}
                      aria-label="Volume"
                      title="Acima de 100% amplifica o som"
                    />
                    <span className={`hud-volume-value num ${volumePct > 100 && !muted ? 'boost' : ''}`}>
                      {muted ? 0 : volumePct}%
                    </span>
                  </div>
                </>
              )}

              {localStream && showLocalPreview && !remoteStream && (
                <button type="button" className="btn btn-secondary" style={{ height: 32 }} onClick={() => setShowLocalPreview(false)}>
                  <EyeOff size={14} /> Desligar prévia
                </button>
              )}

              <span className="hud-sep" />
              <button
                type="button"
                className="btn btn-banana"
                onClick={() => void throwBanana()}
                title="Tacar banana na tela (Tecla B)"
              >
                <BananaIcon size={15} /> Tacar banana
              </button>

              <div style={{ display: 'flex' }}>
                {REACTIONS.map((em) => (
                  <button
                    key={em}
                    type="button"
                    className="reaction-btn"
                    onClick={() => void sendReaction(em)}
                    aria-label={`Reagir com ${em}`}
                  >
                    {em}
                  </button>
                ))}
              </div>

              <span className="hud-sep" />
              <button
                type="button"
                className="btn btn-icon"
                style={{ width: 32, height: 32 }}
                onClick={takeSnapshot}
                title="Salvar print da transmissão"
                aria-label="Salvar print da transmissão"
              >
                <Camera size={15} />
              </button>
              <button
                type="button"
                className="btn btn-icon"
                style={{ width: 32, height: 32 }}
                onClick={() => void toggleFullscreen()}
                title="Tela cheia (F11)"
                aria-label="Tela cheia"
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </div>
          )}
        </main>

        {sidebarOpen && (
          <aside className="sidebar">
            <div className="side-section" style={{ paddingBottom: 10 }}>
              <div className="segmented" role="tablist">
                <button
                  type="button"
                  className="seg"
                  aria-pressed={sidebarTab === 'people'}
                  onClick={() => {
                    setSidebarTab('people');
                    setUnreadChat(false);
                  }}
                >
                  <MessageSquare size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
                  Sala &amp; Chat
                  {unreadChat && <span className="tab-dot" />}
                </button>
                <button
                  type="button"
                  className="seg"
                  aria-pressed={sidebarTab === 'quality'}
                  onClick={() => setSidebarTab('quality')}
                >
                  <SlidersHorizontal size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
                  Vídeo &amp; Som
                </button>
              </div>
            </div>

            {sidebarTab === 'people' ? (
              <>
                <section className="side-section">
                  <h3 className="side-title">
                    Na sala
                    <small className="num">{countLabel(peers.length + 1, 'pessoa', 'pessoas')}</small>
                  </h3>

                  <div className="people">
                    <div className="person">
                      <span className="avatar self">{initials(nickname)}</span>
                      <span className="person-text">
                        <span className="person-name truncate" title={nickname}>
                          {nickname}
                        </span>
                        <span className={`person-sub ${localStream ? 'live' : ''}`}>
                          {localStream ? 'Transmitindo' : 'Você'}
                        </span>
                      </span>
                    </div>

                    {peers.map((p) => {
                      const isWatching = watchTarget === p.peerId && Boolean(remoteStream);
                      return (
                        <div key={p.peerId} className={`person ${isWatching ? 'is-watching' : ''}`}>
                          <span className="avatar">{initials(p.nickname)}</span>
                          <span className="person-text">
                            <span className="person-name truncate" title={p.nickname}>
                              {p.nickname}
                            </span>
                            <span className={`person-sub ${p.isStreaming ? 'live' : ''}`}>
                              {p.isStreaming ? 'Transmitindo' : 'Assistindo'}
                            </span>
                          </span>
                          {p.isStreaming && !isWatching && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => void engineRef.current?.watchStreamer(p.peerId)}
                            >
                              Assistir
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {peers.length === 0 && (
                    <p className="empty-note">
                      Só você por aqui. Copie o convite ali em cima para chamar a turma.
                    </p>
                  )}
                  {streamingPeers.length > 1 && (
                    <p className="field-hint">{streamingPeers.length} pessoas transmitindo. Escolha qual assistir.</p>
                  )}
                </section>

                <section className="side-section">
                  <h3 className="side-title">
                    Chat da sala
                    <small>Ao vivo</small>
                  </h3>
                  <RoomChat messages={chatMessages} onSend={sendChat} />
                </section>
              </>
            ) : (
              <section className="side-section">
                <h3 className="side-title">
                  Transmissão
                  {localStream && <small style={{ color: 'var(--leaf)' }}>Ao vivo, muda na hora</small>}
                </h3>

                <div className="field">
                  <span className="field-label">Perfil rápido</span>
                  <div className="segmented" role="group" aria-label="Perfil rápido">
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={quality.resolution === '1080p' && quality.fps === 60 && quality.bitrateMbps >= 10}
                      onClick={() =>
                        void applyQualityChange({
                          profile: 'cinema',
                          resolution: '1080p',
                          fps: 60,
                          bitrateMbps: 12,
                        })
                      }
                    >
                      Cinema
                    </button>
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={quality.resolution === '720p' && quality.fps === 60 && quality.bitrateMbps <= 6}
                      onClick={() =>
                        void applyQualityChange({
                          profile: 'cinema',
                          resolution: '720p',
                          fps: 60,
                          bitrateMbps: 5,
                        })
                      }
                    >
                      Jogo leve
                    </button>
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={quality.resolution === '720p' && quality.fps === 30}
                      onClick={() =>
                        void applyQualityChange({
                          profile: 'cinema',
                          resolution: '720p',
                          fps: 30,
                          bitrateMbps: 3,
                        })
                      }
                    >
                      PC fraco
                    </button>
                  </div>
                </div>

                {nativeBridge.supportsNativeDxgiTrack && (
                  <div className="field">
                    <span className="field-label">Captura</span>
                    <div className="segmented" role="group" aria-label="Modo de captura">
                      <button
                        type="button"
                        className="seg"
                        aria-pressed={quality.captureSource === 'dxgi-monitor'}
                        onClick={() =>
                          void applyQualityChange({ captureSource: 'dxgi-monitor' as CaptureSource })
                        }
                      >
                        Monitor DXGI (Jogos)
                      </button>
                      <button
                        type="button"
                        className="seg"
                        aria-pressed={quality.captureSource === 'window-picker'}
                        onClick={() =>
                          void applyQualityChange({ captureSource: 'window-picker' as CaptureSource })
                        }
                      >
                        Escolher janela
                      </button>
                    </div>
                    {quality.captureSource === 'dxgi-monitor' && monitors.length > 0 && (
                      <select
                        className="select"
                        value={quality.monitorIndex}
                        onChange={(e) =>
                          void applyQualityChange({ monitorIndex: Number(e.target.value) })
                        }
                        aria-label="Monitor"
                      >
                        {monitors.map((m) => (
                          <option key={m.index} value={m.index}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                <div className="field">
                  <span className="field-label">Resolução</span>
                  <div className="segmented" role="group" aria-label="Resolução">
                    {(['720p', '1080p', '1440p', 'native'] as ResolutionPreset[]).map((res) => (
                      <button
                        key={res}
                        type="button"
                        className="seg"
                        aria-pressed={quality.resolution === res}
                        onClick={() => void applyQualityChange({ resolution: res })}
                      >
                        {res === 'native' ? 'Nativa' : res}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">Quadros por segundo</span>
                  <div className="segmented" role="group" aria-label="Quadros por segundo">
                    {[60, 30].map((f) => (
                      <button
                        key={f}
                        type="button"
                        className="seg"
                        aria-pressed={quality.fps === f}
                        onClick={() => void applyQualityChange({ fps: f as 30 | 60 })}
                      >
                        {f} fps
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="bitrate">
                    Qualidade máxima
                    <span className="num" style={{ fontWeight: 600 }}>
                      {quality.bitrateMbps} Mbps
                    </span>
                  </label>
                  <input
                    id="bitrate"
                    type="range"
                    className="range"
                    min={2}
                    max={25}
                    step={1}
                    value={quality.bitrateMbps}
                    onChange={(e) => void applyQualityChange({ bitrateMbps: Number(e.target.value) })}
                  />
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="audio-mode">
                    Som
                    <button
                      type="button"
                      className="btn btn-icon"
                      style={{ width: 24, height: 24 }}
                      onClick={() => void refreshAudioApps()}
                      title="Atualizar lista de programas"
                      aria-label="Atualizar lista de programas"
                    >
                      <RefreshCw size={12} />
                    </button>
                  </label>
                  <select
                    id="audio-mode"
                    className="select"
                    value={quality.audioMode}
                    onChange={(e) => void applyQualityChange({ audioMode: e.target.value as AudioCaptureMode })}
                  >
                    <option value="exclude-discord">PC inteiro, menos o Discord</option>
                    <option value="include-process">Só um programa</option>
                    <option value="system-all">PC inteiro</option>
                    <option value="none">Sem som</option>
                  </select>

                  {quality.audioMode === 'include-process' && (
                    <select
                      className="select"
                      value={quality.targetPid}
                      onChange={(e) => void applyQualityChange({ targetPid: Number(e.target.value) })}
                      aria-label="Programa"
                    >
                      {audioProcesses.length === 0 && <option value={0}>Nenhum programa com janela aberto</option>}
                      {audioProcesses.map((proc) => (
                        <option key={proc.pid} value={proc.pid}>
                          {proc.name}: {proc.title.length > 40 ? `${proc.title.slice(0, 40)}…` : proc.title}
                        </option>
                      ))}
                    </select>
                  )}

                  {quality.audioMode === 'exclude-discord' && (
                    <p className="note">
                      <ShieldCheck size={14} />
                      {discordDetected
                        ? 'Discord aberto. A voz da call não entra no som da transmissão.'
                        : 'Discord fechado. Se abrir durante a transmissão, a voz continua de fora.'}
                    </p>
                  )}
                </div>

                {localStream && quality.audioMode !== 'none' && (
                  <div className="meter">
                    <div className="meter-head">
                      <span>Som saindo</span>
                      <span className="num">{vuLevel}%</span>
                    </div>
                    <div className="meter-track">
                      <div className="meter-fill" style={{ transform: `scaleX(${vuLevel / 100})` }} />
                    </div>
                  </div>
                )}

                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={quality.cascadeRelay}
                    onChange={(e) => void applyQualityChange({ cascadeRelay: e.target.checked })}
                  />
                  <span>
                    Dividir o envio com quem assiste
                    <small>Use se tiver 4 pessoas ou mais e sua internet travar.</small>
                  </span>
                </label>
              </section>
            )}
          </aside>
        )}
      </div>

      <ShareModal
        open={shareModalOpen}
        initialQuality={quality}
        discordDetected={discordDetected}
        onClose={() => setShareModalOpen(false)}
        onStartShare={startShareWithConfig}
      />
    </div>
  );
}

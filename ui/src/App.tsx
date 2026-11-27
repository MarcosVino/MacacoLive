import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  LoaderCircle,
  LogOut,
  Maximize2,
  Minimize2,
  MonitorUp,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  RefreshCw,
  ShieldCheck,
  Shuffle,
  Square,
  TriangleAlert,
  Tv,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import { LogoMark } from './Logo';
import { nativeBridge } from './nativeBridge';
import {
  AudioCaptureMode,
  AudioProcessInfo,
  PeerInfo,
  ResolutionPreset,
  StreamQualityConfig,
  StreamStats,
  UpdateCheckResult,
} from './types';
import { MacacoWebRtcEngine } from './webrtcEngine';

interface FloatingReaction {
  id: string;
  nick: string;
  emoji: string;
}

const DEFAULT_QUALITY: StreamQualityConfig = {
  resolution: '1080p',
  fps: 60,
  bitrateMbps: 12,
  profile: 'cinema',
  audioMode: 'exclude-discord',
  targetPid: 0,
  cascadeRelay: false,
};

const REACTIONS = ['🍌', '😂', '🔥', '👏', '😮'];
const WATCH_TIMEOUT_MS = 15000;

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

export function App() {
  const [inRoom, setInRoom] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  const [nickname, setNickname] = useState(() => localStorage.getItem('ml_nick') || '');
  const [roomCode, setRoomCode] = useState(() => localStorage.getItem('ml_room') || randomRoomName());
  const [roomPassword, setRoomPassword] = useState('');

  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [brokerCount, setBrokerCount] = useState(1);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [copied, setCopied] = useState(false);

  const [quality, setQuality] = useState<StreamQualityConfig>(DEFAULT_QUALITY);
  const [audioProcesses, setAudioProcesses] = useState<AudioProcessInfo[]>([]);
  const [discordDetected, setDiscordDetected] = useState(false);
  const [audioStatus, setAudioStatus] = useState('');
  const [vuLevel, setVuLevel] = useState(0);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [showLocalPreview, setShowLocalPreview] = useState(false);
  const [shareError, setShareError] = useState('');

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [watchTarget, setWatchTarget] = useState<string | null>(null);
  const [watchFailed, setWatchFailed] = useState(false);

  const [volumePct, setVolumePct] = useState(100);
  const [muted, setMuted] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mouseIdle, setMouseIdle] = useState(false);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState('');

  const engineRef = useRef<MacacoWebRtcEngine | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  const gainCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

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
      const info = await nativeBridge.listAudioApps();
      setAudioProcesses(info.processes);
      setDiscordDetected(info.discordRunning);
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

  // Extra GainNode only for boost above 100% (105% - 200%)
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
      // Native <video> already outputs 100%; GainNode adds the extra (volumePct - 100)%
      gain.gain.value = (volumePct - 100) / 100;
      source.connect(gain);
      gain.connect(ctx.destination);
      sourceNodeRef.current = source;
      gainNodeRef.current = gain;
    } catch {}
  }, [remoteStream, volumePct, muted]);

  // Connecting state with timeout -> error + retry
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
    // In desktop app, native WebView2 AcceleratorKeyPressed handles F11 & Escape reliably without double-toggle
    if (nativeBridge.isDesktopApp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        void toggleFullscreen();
      } else if (e.key === 'Escape' && isFullscreen) {
        void toggleFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  const pushReaction = (nick: string, emoji: string) => {
    const id = crypto.randomUUID();
    setReactions((prev) => [...prev.slice(-5), { id, nick, emoji }]);
    window.setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), 3100);
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const room = roomCode.trim();
    if (!room) return;

    const nick = nickname.trim() || `Macaco ${Math.floor(10 + Math.random() * 89)}`;
    setNickname(nick);
    localStorage.setItem('ml_nick', nick);
    localStorage.setItem('ml_room', room);

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
        },
        quality
      );
      engineRef.current = engine;
      await engine.joinRoom(nick, room, roomPassword);
      setInRoom(true);
    } catch (err: any) {
      setJoinError(err?.message || 'Não foi possível entrar na sala.');
    } finally {
      setJoining(false);
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
    // Detach video/audio elements immediately so browser never holds a live MediaStreamTrack reference
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

    setLocalStream(null);
    setShowLocalPreview(false);
    setRemoteStream(null);
    setWatchTarget(null);
    setStats(null);
    setPeers([]);
    setInRoom(false);

    try {
      if (isFullscreen) await toggleFullscreen(false);
    } catch {}

    if (engine) {
      try {
        await engine.leaveRoom();
      } catch {}
    }
  };

  const handleStartShare = async () => {
    if (!engineRef.current) return;
    setShareError('');
    try {
      await engineRef.current.startScreenShare(quality);
    } catch (err: any) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setShareError(err?.message || 'Não foi possível capturar a tela.');
      }
    }
  };

  const handleStopShare = async () => {
    await engineRef.current?.stopScreenShare();
    setShowLocalPreview(false);
  };

  const applyQualityChange = async (patch: Partial<StreamQualityConfig>) => {
    const next = { ...quality, ...patch };
    setQuality(next);
    if (engineRef.current && localStream) {
      const label = await engineRef.current.updateLiveQuality(next);
      if (label) setAudioStatus(label);
    }
  };

  const toggleFullscreen = async (force?: boolean) => {
    const next = typeof force === 'boolean' ? force : !isFullscreen;
    setIsFullscreen(next);
    if (next) setSidebarOpen(false);
    await nativeBridge.setFullscreen(next);
  };

  const copyInvite = async () => {
    const lines = [`Sala do MacacoLive: ${roomCode.trim()}`];
    if (roomPassword.trim()) lines.push(`Senha: ${roomPassword.trim()}`);
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const sendReaction = async (emoji: string) => {
    pushReaction('Você', emoji);
    await engineRef.current?.sendReaction(emoji);
  };

  /* ---------------- Lobby ---------------- */
  if (!inRoom) {
    return (
      <main className="lobby">
        <form className="lobby-form" onSubmit={handleJoinRoom}>
          <header className="lobby-head">
            <LogoMark size={48} title="MacacoLive" />
            <h1>MacacoLive</h1>
            <p>Transmita sua tela com som para a turma assistir junto.</p>
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
                placeholder="Sem senha, entra quem souber o nome da sala"
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

          <p className="lobby-foot">
            O vídeo vai direto do PC de quem transmite para quem assiste. A senha criptografa o convite da sala. · v1.4.0
          </p>

          {updateInfo?.available && (
            <div className="update-bar" role="status">
              <div className="update-bar-text">
                <strong>Nova versão v{updateInfo.latestVersion}</strong>
                {updateError ? (
                  <span style={{ color: '#f3a395' }}>{updateError}</span>
                ) : (
                  <span>Baixa em segundos e reabre sozinho.</span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={updating}
                onClick={() => void handleInstallUpdate()}
              >
                {updating ? (
                  <>
                    <LoaderCircle size={14} className="spin" /> Atualizando
                  </>
                ) : (
                  <>
                    <Download size={14} /> Atualizar
                  </>
                )}
              </button>
            </div>
          )}
        </form>
      </main>
    );
  }

  /* ---------------- Room ---------------- */
  const watchingPeer = peers.find((p) => p.peerId === watchTarget);
  const streamingPeers = peers.filter((p) => p.isStreaming);
  const chromeHidden = mouseIdle && (isFullscreen || !sidebarOpen) && Boolean(remoteStream);
  const disconnected = brokerCount === 0;

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
              ? `${countLabel(peers.length, 'pessoa recebe', 'pessoas recebem')} sua tela. A prévia aqui fica desligada para poupar a placa de vídeo.`
              : 'Ninguém entrou ainda. Mande o nome da sala no Discord.'}
          </p>
          {audioStatus && (
            <p className="note" style={{ justifyContent: 'center' }}>
              <ShieldCheck size={14} />
              {audioStatus}
            </p>
          )}
          <div className="stage-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setShowLocalPreview(true)}>
              <Eye size={15} /> Ver minha tela
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
        <button type="button" className="btn btn-primary btn-lg" onClick={handleStartShare}>
          <MonitorUp size={16} /> Transmitir tela
        </button>
      </div>
    );
  };

  return (
    <div
      className={`room ${chromeHidden ? 'chrome-hidden cursor-hidden' : ''}`}
      onMouseMove={handleMouseMove}
    >
      <header className="topbar">
        <LogoMark size={26} title="MacacoLive" />

        <div className="topbar-room">
          <span
            className={`conn-dot ${disconnected ? 'off' : ''}`}
            title={disconnected ? 'Sem conexão com a sala' : 'Conectado à sala'}
          />
          <span className="topbar-room-name truncate" title={roomCode}>
            {roomCode}
          </span>
          <button
            type="button"
            className="btn btn-icon"
            style={{ width: 28, height: 28 }}
            onClick={copyInvite}
            title="Copiar convite"
            aria-label="Copiar convite da sala"
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
          {localStream ? (
            <button type="button" className="btn btn-danger" onClick={handleStopShare}>
              <Square size={13} /> Parar transmissão
            </button>
          ) : (displayStream || watchTarget) ? (
            <button type="button" className="btn btn-primary" onClick={handleStartShare}>
              <MonitorUp size={15} /> Transmitir tela
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setSidebarOpen((v) => !v)}
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
        <main className="stage" onDoubleClick={() => displayStream && void toggleFullscreen()}>
          {renderStage()}

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
                  Só você por aqui. Mande <strong>{roomCode}</strong> no Discord, ou use o botão de copiar convite no topo.
                </p>
              )}
              {streamingPeers.length > 1 && (
                <p className="field-hint">{streamingPeers.length} pessoas transmitindo. Escolha qual assistir.</p>
              )}
            </section>

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
                <span className="field-hint">
                  No Valorant, use <strong>Janela sem Bordas</strong> nas opções de vídeo para não travar ao dar Alt+Tab.
                </span>
              </div>

              <div className="field">
                <span className="field-label">Conteúdo</span>
                <div className="segmented" role="group" aria-label="Tipo de conteúdo">
                  <button
                    type="button"
                    className="seg"
                    aria-pressed={quality.profile === 'cinema'}
                    onClick={() => void applyQualityChange({ profile: 'cinema' })}
                  >
                    Filme ou jogo
                  </button>
                  <button
                    type="button"
                    className="seg"
                    aria-pressed={quality.profile === 'detail'}
                    onClick={() => void applyQualityChange({ profile: 'detail' })}
                  >
                    Texto ou código
                  </button>
                </div>
                <span className="field-hint">
                  {quality.profile === 'cinema'
                    ? 'Prioriza 60 fps lisos. Em jogos tela cheia (ex: Valorant), escolha a aba Tela inteira.'
                    : 'Prioriza nitidez de letras. Em cenas rápidas pode cair o fps.'}
                </span>
              </div>

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
                <span className="field-hint">
                  Cada pessoa assistindo usa isso do seu upload.
                  {peers.length > 0 &&
                    ` Agora: cerca de ${Math.round(quality.bitrateMbps * peers.length)} Mbps.`}
                </span>
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
                {quality.audioMode === 'system-all' && (
                  <p className="note" style={{ color: 'var(--text-2)' }}>
                    <TriangleAlert size={14} style={{ color: 'var(--banana)' }} />
                    A voz da call do Discord vai junto e a turma escuta eco.
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
                  <small>Use se tiver 4 pessoas ou mais e sua internet travar. Quem assiste repassa a tela para os outros.</small>
                </span>
              </label>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}

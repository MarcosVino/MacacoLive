import React, { useEffect, useState } from 'react';
import {
  AppWindow,
  Check,
  LoaderCircle,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Volume2,
  X,
} from 'lucide-react';
import { nativeBridge } from '../nativeBridge';
import {
  AudioCaptureMode,
  CapturePreviews,
  CaptureSource,
  StreamQualityConfig,
} from '../types';

interface ShareModalProps {
  open: boolean;
  initialQuality: StreamQualityConfig;
  discordDetected: boolean;
  onClose: () => void;
  onStartShare: (nextQuality: StreamQualityConfig) => Promise<void>;
}

export function ShareModal({
  open,
  initialQuality,
  discordDetected,
  onClose,
  onStartShare,
}: ShareModalProps) {
  const [tab, setTab] = useState<CaptureSource>(
    nativeBridge.supportsNativeDxgiTrack ? initialQuality.captureSource : 'window-picker'
  );
  const [draft, setDraft] = useState<StreamQualityConfig>(initialQuality);
  const [previews, setPreviews] = useState<CapturePreviews>({ monitors: [], windows: [] });
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [selectedWindowPid, setSelectedWindowPid] = useState<number>(0);

  const loadPreviews = async () => {
    if (!nativeBridge.isDesktopApp) return;
    setLoading(true);
    try {
      const data = await nativeBridge.listCapturePreviews();
      setPreviews(data);
      if (data.monitors.length > 0 && !data.monitors.some((m) => m.index === draft.monitorIndex)) {
        setDraft((d) => ({ ...d, monitorIndex: data.monitors[0].index }));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setDraft(initialQuality);
    setTab(nativeBridge.supportsNativeDxgiTrack ? initialQuality.captureSource : 'window-picker');
    setSelectedWindowPid(0);
    void loadPreviews();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSelectWindowApp = (pid: number) => {
    setSelectedWindowPid(pid);
    setTab('window-picker');
    setDraft((d) => ({
      ...d,
      captureSource: 'window-picker',
      audioMode: 'include-process',
      targetPid: pid,
    }));
  };

  const handleConfirm = async () => {
    setStarting(true);
    try {
      const finalConfig: StreamQualityConfig = {
        ...draft,
        captureSource: tab,
      };
      await onStartShare(finalConfig);
      onClose();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2 id="share-modal-title">O que você quer transmitir</h2>
            <p>Escolha um monitor para jogos ou um aplicativo aberto</p>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {nativeBridge.isDesktopApp && (
              <button
                type="button"
                className="btn btn-icon"
                onClick={() => void loadPreviews()}
                disabled={loading}
                title="Atualizar telas e aplicativos"
                aria-label="Atualizar telas e aplicativos"
              >
                <RefreshCw size={15} className={loading ? 'spin' : ''} />
              </button>
            )}
            <button
              type="button"
              className="btn btn-icon"
              onClick={onClose}
              aria-label="Fechar"
            >
              <X size={17} />
            </button>
          </div>
        </header>

        {nativeBridge.supportsNativeDxgiTrack && (
          <div className="modal-tabs">
            <button
              type="button"
              className={`modal-tab ${tab === 'dxgi-monitor' ? 'active' : ''}`}
              onClick={() => {
                setTab('dxgi-monitor');
                setDraft((d) => ({ ...d, captureSource: 'dxgi-monitor' }));
              }}
            >
              <Monitor size={15} /> Telas / Jogos (DXGI)
            </button>
            <button
              type="button"
              className={`modal-tab ${tab === 'window-picker' ? 'active' : ''}`}
              onClick={() => {
                setTab('window-picker');
                setDraft((d) => ({ ...d, captureSource: 'window-picker' }));
              }}
            >
              <AppWindow size={15} /> Aplicativos ({previews.windows.length})
            </button>
          </div>
        )}

        <div className="modal-body">
          {tab === 'dxgi-monitor' && nativeBridge.supportsNativeDxgiTrack ? (
            <div className="source-grid">
              {loading && previews.monitors.length === 0 && (
                <div className="modal-empty">
                  <LoaderCircle size={20} className="spin" />
                  <span>Carregando monitores...</span>
                </div>
              )}

              {previews.monitors.map((mon) => {
                const selected = draft.monitorIndex === mon.index;
                return (
                  <button
                    key={mon.index}
                    type="button"
                    className={`monitor-card ${selected ? 'selected' : ''}`}
                    onClick={() => setDraft((d) => ({ ...d, monitorIndex: mon.index }))}
                  >
                    <div className="monitor-thumb">
                      {mon.thumbDataUrl ? (
                        <img src={mon.thumbDataUrl} alt={mon.name} />
                      ) : (
                        <Monitor size={28} color="var(--text-3)" />
                      )}
                      {selected && (
                        <span className="check-badge">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                    <div className="monitor-meta">
                      <strong className="truncate">{mon.name}</strong>
                      <span className="num">
                        {mon.width}×{mon.height} · DXGI direto da GPU
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="app-picker-wrap">
              <p className="field-hint" style={{ marginBottom: 10 }}>
                Clique num programa para já isolar o som dele, e depois confirme para escolher a janela no Windows.
              </p>
              <div className="window-list">
                {previews.windows.map((w) => {
                  const selected = selectedWindowPid === w.pid;
                  return (
                    <button
                      key={w.pid}
                      type="button"
                      className={`window-row ${selected ? 'selected' : ''}`}
                      onClick={() => handleSelectWindowApp(w.pid)}
                    >
                      <span className="win-icon">
                        {w.iconDataUrl ? (
                          <img src={w.iconDataUrl} width={24} height={24} alt="" />
                        ) : (
                          <AppWindow size={18} />
                        )}
                      </span>
                      <span className="win-text">
                        <strong className="truncate">{w.name}</strong>
                        <small className="truncate">{w.title}</small>
                      </span>
                      {selected && (
                        <span className="win-audio-tag">
                          <Volume2 size={12} /> Som isolado
                        </span>
                      )}
                    </button>
                  );
                })}
                {!loading && previews.windows.length === 0 && (
                  <div className="modal-empty">
                    <span>Nenhuma janela visível detectada. O seletor padrão do Windows será aberto ao confirmar.</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="modal-settings">
            <div className="field">
              <span className="field-label">Perfil de transmissão</span>
              <div className="segmented">
                <button
                  type="button"
                  className="seg"
                  aria-pressed={draft.resolution === '1080p' && draft.fps === 60 && draft.bitrateMbps >= 10}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      profile: 'cinema',
                      resolution: '1080p',
                      fps: 60,
                      bitrateMbps: 12,
                    }))
                  }
                >
                  Cinema (1080p60)
                </button>
                <button
                  type="button"
                  className="seg"
                  aria-pressed={draft.resolution === '720p' && draft.fps === 60 && draft.bitrateMbps <= 6}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      profile: 'cinema',
                      resolution: '720p',
                      fps: 60,
                      bitrateMbps: 5,
                    }))
                  }
                >
                  Jogo leve (720p60)
                </button>
                <button
                  type="button"
                  className="seg"
                  aria-pressed={draft.resolution === '720p' && draft.fps === 30}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      profile: 'cinema',
                      resolution: '720p',
                      fps: 30,
                      bitrateMbps: 3,
                    }))
                  }
                >
                  PC fraco (720p30)
                </button>
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="modal-audio">
                Som da transmissão
              </label>
              <select
                id="modal-audio"
                className="select"
                value={draft.audioMode}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    audioMode: e.target.value as AudioCaptureMode,
                  }))
                }
              >
                <option value="exclude-discord">PC inteiro, menos o Discord</option>
                <option value="include-process">Só um programa específico</option>
                <option value="system-all">PC inteiro</option>
                <option value="none">Sem som</option>
              </select>

              {draft.audioMode === 'include-process' && previews.windows.length > 0 && (
                <select
                  className="select"
                  value={draft.targetPid}
                  onChange={(e) => setDraft((d) => ({ ...d, targetPid: Number(e.target.value) }))}
                  aria-label="Programa de áudio"
                >
                  {previews.windows.map((w) => (
                    <option key={w.pid} value={w.pid}>
                      {w.name}: {w.title.length > 42 ? `${w.title.slice(0, 42)}…` : w.title}
                    </option>
                  ))}
                </select>
              )}

              {draft.audioMode === 'exclude-discord' && (
                <p className="note" style={{ marginTop: 2 }}>
                  <ShieldCheck size={14} />
                  {discordDetected
                    ? 'Discord detectado e isolado automaticamente.'
                    : 'Se abrir o Discord, a call fica de fora da live.'}
                </p>
              )}
            </div>
          </div>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting}
            onClick={() => void handleConfirm()}
          >
            {starting ? (
              <>
                <LoaderCircle size={15} className="spin" /> Iniciando...
              </>
            ) : tab === 'window-picker' ? (
              'Escolher janela no Windows'
            ) : (
              'Iniciar transmissão'
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

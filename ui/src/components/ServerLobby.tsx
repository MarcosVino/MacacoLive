import React, { useState } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  Check,
  Compass,
  Copy,
  Film,
  Gamepad2,
  Hash,
  Home,
  Lock,
  LogOut,
  MonitorPlay,
  Pin,
  PinOff,
  Plus,
  Radio,
  Shuffle,
  Trash2,
  TriangleAlert,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  ChannelPresenceEntry,
  SavedRoomRecord,
  ServerChannelRecord,
  ServerMemberRecord,
  ServerRecord,
} from '../supabaseClient';

interface ServerLobbyProps {
  user: User;
  nickname: string;
  onNicknameChange: (nick: string) => void;
  servers: ServerRecord[];
  activeServerId: string; // 'home' or server uuid
  onSelectServer: (id: string) => void;
  serverRoster: ServerMemberRecord[];
  presenceByKey: Record<string, ChannelPresenceEntry>;
  savedRooms: SavedRoomRecord[];
  roomCode: string;
  onRoomCodeChange: (code: string) => void;
  roomPassword: string;
  onRoomPasswordChange: (pass: string) => void;
  onRandomRoom: () => void;
  joining: boolean;
  joinError: string;
  onJoinChannel: (ch: ServerChannelRecord, server: ServerRecord) => void;
  onJoinQuickRoom: (code: string, pass: string, label?: string) => void;
  onTogglePin: (room: SavedRoomRecord) => void;
  onRemoveRoom: (roomCode: string) => void;
  onCreateServer: (name: string, accentColor: string) => Promise<void>;
  onJoinByInvite: (inviteCode: string) => Promise<void>;
  onCreateChannel: (
    serverId: string,
    name: string,
    kind: 'stream' | 'game' | 'movie'
  ) => Promise<void>;
  onDeleteChannel: (channel: ServerChannelRecord) => Promise<void>;
  onLeaveOrDeleteServer: (server: ServerRecord) => Promise<void>;
  relativeTimeLabel: (iso: string) => string;
}

const SERVER_COLORS = ['#f5c842', '#8dbf6a', '#6eb5ff', '#f38b6b', '#c69bff'];

function serverInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'ML';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function channelIcon(kind: ServerChannelRecord['channel_kind']) {
  if (kind === 'game') return <Gamepad2 size={15} />;
  if (kind === 'movie') return <Film size={15} />;
  return <MonitorPlay size={15} />;
}

export const ServerLobby: React.FC<ServerLobbyProps> = ({
  user,
  nickname,
  onNicknameChange,
  servers,
  activeServerId,
  onSelectServer,
  serverRoster,
  presenceByKey,
  savedRooms,
  roomCode,
  onRoomCodeChange,
  roomPassword,
  onRoomPasswordChange,
  onRandomRoom,
  joining,
  joinError,
  onJoinChannel,
  onJoinQuickRoom,
  onTogglePin,
  onRemoveRoom,
  onCreateServer,
  onJoinByInvite,
  onCreateChannel,
  onDeleteChannel,
  onLeaveOrDeleteServer,
  relativeTimeLabel,
}) => {
  const [modalMode, setModalMode] = useState<'none' | 'create-server' | 'join-invite' | 'create-channel'>('none');
  const [newServerName, setNewServerName] = useState('');
  const [newServerColor, setNewServerColor] = useState(SERVER_COLORS[0]);
  const [inviteInput, setInviteInput] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelKind, setNewChannelKind] = useState<'stream' | 'game' | 'movie'>('stream');
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const [copiedInvite, setCopiedInvite] = useState(false);

  const activeServer =
    activeServerId !== 'home' ? servers.find((s) => s.id === activeServerId) ?? null : null;

  const onlineEntries = Object.values(presenceByKey);

  const submitCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName.trim() || modalBusy) return;
    setModalBusy(true);
    setModalError('');
    try {
      await onCreateServer(newServerName, newServerColor);
      setNewServerName('');
      setModalMode('none');
    } catch (err: any) {
      setModalError(err?.message || 'Não foi possível criar o servidor.');
    } finally {
      setModalBusy(false);
    }
  };

  const submitJoinInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteInput.trim() || modalBusy) return;
    setModalBusy(true);
    setModalError('');
    try {
      await onJoinByInvite(inviteInput);
      setInviteInput('');
      setModalMode('none');
    } catch (err: any) {
      setModalError(err?.message || 'Convite não encontrado.');
    } finally {
      setModalBusy(false);
    }
  };

  const submitCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeServer || !newChannelName.trim() || modalBusy) return;
    setModalBusy(true);
    setModalError('');
    try {
      await onCreateChannel(activeServer.id, newChannelName, newChannelKind);
      setNewChannelName('');
      setModalMode('none');
    } catch (err: any) {
      setModalError(err?.message || 'Não foi possível criar o canal.');
    } finally {
      setModalBusy(false);
    }
  };

  const copyServerInvite = async (srv: ServerRecord) => {
    const txt = `Entre no servidor "${srv.name}" no MacacoLive!\nCódigo de convite: ${srv.invite_code}`;
    await navigator.clipboard.writeText(txt);
    setCopiedInvite(true);
    window.setTimeout(() => setCopiedInvite(false), 1800);
  };

  return (
    <div className="discord-shell view-enter">
      {/* Rail 1: Server icons */}
      <nav className="server-rail" aria-label="Servidores">
        <button
          type="button"
          className={`srv-pill ${activeServer === null ? 'active' : ''}`}
          onClick={() => onSelectServer('home')}
          title="Início e salas avulsas"
          aria-label="Início e salas avulsas"
        >
          <Home size={19} />
        </button>

        <div className="srv-sep" />

        <div className="srv-list">
          {servers.map((srv) => {
            const isActive = activeServer?.id === srv.id;
            return (
              <button
                key={srv.id}
                type="button"
                className={`srv-pill ${isActive ? 'active' : ''}`}
                style={{ '--srv-color': srv.accent_color } as React.CSSProperties}
                onClick={() => onSelectServer(srv.id)}
                title={srv.name}
                aria-label={srv.name}
              >
                <span>{serverInitials(srv.name)}</span>
              </button>
            );
          })}
        </div>

        <div className="srv-sep" />

        <button
          type="button"
          className="srv-pill srv-action"
          onClick={() => {
            setModalError('');
            setModalMode('create-server');
          }}
          title="Criar novo servidor"
          aria-label="Criar novo servidor"
        >
          <Plus size={19} />
        </button>

        <button
          type="button"
          className="srv-pill srv-action"
          onClick={() => {
            setModalError('');
            setModalMode('join-invite');
          }}
          title="Entrar com código de convite"
          aria-label="Entrar com código de convite"
        >
          <Compass size={18} />
        </button>
      </nav>

      {/* Main Discord content: either Selected Server or Home Quick Rooms */}
      {activeServer ? (
        <div className="server-workspace">
          {/* Channel panel */}
          <section className="server-panel">
            <header className="server-panel-head">
              <div className="server-title-row">
                <span
                  className="server-color-dot"
                  style={{ background: activeServer.accent_color }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h1 className="truncate">{activeServer.name}</h1>
                  <span className="field-hint num">Convite: {activeServer.invite_code}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ height: 32, padding: '0 10px', fontSize: 12 }}
                  onClick={() => void copyServerInvite(activeServer)}
                  title="Copiar código de convite"
                >
                  {copiedInvite ? (
                    <>
                      <Check size={13} color="var(--leaf)" /> Copiado
                    </>
                  ) : (
                    <>
                      <Copy size={13} /> Convidar
                    </>
                  )}
                </button>
              </div>

              <div className="server-subbar">
                <span className="field-hint">
                  CANAIS DE TRANSMISSÃO ({activeServer.channels.length})
                </span>
                <button
                  type="button"
                  className="btn btn-icon"
                  style={{ width: 26, height: 26 }}
                  onClick={() => {
                    setModalError('');
                    setModalMode('create-channel');
                  }}
                  title="Novo canal no servidor"
                  aria-label="Novo canal no servidor"
                >
                  <Plus size={14} />
                </button>
              </div>
            </header>

            {joinError && (
              <div className="inline-error" role="alert" style={{ marginBottom: 12 }}>
                <TriangleAlert size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{joinError}</span>
              </div>
            )}

            <div className="channel-cards">
              {activeServer.channels.map((ch, idx) => {
                const occupants = onlineEntries.filter(
                  (o) => o.channelRoomCode === ch.room_code
                );
                const liveNow = occupants.some((o) => o.isStreaming);
                const canDelete =
                  activeServer.channels.length > 1 &&
                  (activeServer.owner_id === user.id || ch.created_by === user.id);

                return (
                  <div
                    key={ch.id}
                    className={`channel-card item-enter ${liveNow ? 'is-live' : ''}`}
                    style={{ animationDelay: `${Math.min(idx * 35, 160)}ms` }}
                  >
                    <button
                      type="button"
                      className="channel-card-btn"
                      disabled={joining}
                      onClick={() => onJoinChannel(ch, activeServer)}
                    >
                      <span className="channel-icon">{channelIcon(ch.channel_kind)}</span>
                      <span className="channel-meta">
                        <span className="channel-name-row">
                          <span className="truncate">{ch.name}</span>
                          {liveNow && (
                            <span className="live-pill">
                              <Radio size={11} /> AO VIVO
                            </span>
                          )}
                        </span>
                        <span className="channel-sub num">
                          {occupants.length > 0
                            ? `${occupants.length} na sala · ${occupants
                                .map((o) => o.nickname)
                                .slice(0, 3)
                                .join(', ')}`
                            : 'Clique para entrar e transmitir'}
                        </span>
                      </span>
                    </button>

                    {canDelete && (
                      <button
                        type="button"
                        className="btn btn-icon channel-del-btn"
                        onClick={() => void onDeleteChannel(ch)}
                        title="Excluir canal"
                        aria-label={`Excluir canal ${ch.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <footer className="server-panel-foot">
              <label className="field" style={{ flex: 1, minWidth: 160 }}>
                <span className="field-label">Seu apelido nas salas</span>
                <input
                  className="input"
                  style={{ height: 34 }}
                  value={nickname}
                  onChange={(e) => onNicknameChange(e.target.value)}
                  maxLength={40}
                />
              </label>

              <button
                type="button"
                className="btn btn-secondary"
                style={{ height: 34, fontSize: 12 }}
                onClick={() => void onLeaveOrDeleteServer(activeServer)}
              >
                <LogOut size={13} />
                {activeServer.owner_id === user.id ? 'Excluir servidor' : 'Sair do servidor'}
              </button>
            </footer>
          </section>

          {/* Roster / Online Members panel */}
          <aside className="roster-panel">
            <header className="lobby-head" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Users size={15} color="var(--banana)" /> Turma do servidor
                </h2>
                <span className="field-hint num">{serverRoster.length}</span>
              </div>
              <p>Veja quem está online nos canais agora.</p>
            </header>

            <div className="roster-list">
              {serverRoster.map((m) => {
                const live = onlineEntries.find((o) => o.userId === m.user_id);
                const liveChannel = live?.channelRoomCode
                  ? activeServer.channels.find((c) => c.room_code === live.channelRoomCode)
                  : null;
                return (
                  <div key={m.user_id} className="roster-item">
                    <span className={`avatar ${m.user_id === user.id ? 'self' : ''}`}>
                      {serverInitials(live?.nickname || m.nickname)}
                      <span className={`presence-dot ${live ? 'on' : ''}`} />
                    </span>
                    <div className="person-text">
                      <span className="person-name truncate">
                        {live?.nickname || m.nickname}
                        {m.role === 'owner' && <span className="owner-tag">Dono</span>}
                      </span>
                      <span className={`person-sub ${live?.isStreaming ? 'live' : ''}`}>
                        {liveChannel
                          ? live?.isStreaming
                            ? `Ao vivo em #${liveChannel.name}`
                            : `Em #${liveChannel.name}`
                          : live
                            ? 'Online no lobby'
                            : 'Offline'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      ) : (
        <div className="lobby-grid" style={{ flex: 1 }}>
          {/* Home: Quick Join Room + Saved Rooms */}
          <form
            className="lobby-card view-enter"
            onSubmit={(e) => {
              e.preventDefault();
              onJoinQuickRoom(roomCode, roomPassword);
            }}
          >
            <header className="lobby-head">
              <h1>
                {servers.length === 0 ? 'Crie um servidor ou entre em sala' : 'Sala avulsa'}
              </h1>
              <p>
                {servers.length === 0
                  ? 'Monte um servidor estilo Discord com canais fixos pro seu grupo, ou entre direto numa sala avulsa.'
                  : 'Quer transmitir rápido fora de um servidor? Entre em qualquer sala abaixo.'}
              </p>
            </header>

            {servers.length === 0 && (
              <div className="cta-pair">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setModalError('');
                    setModalMode('create-server');
                  }}
                >
                  <Plus size={15} /> Criar servidor
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setModalError('');
                    setModalMode('join-invite');
                  }}
                >
                  <Compass size={15} /> Tenho um convite
                </button>
              </div>
            )}

            <div className="lobby-fields">
              <label className="field">
                <span className="field-label">Apelido</span>
                <input
                  className="input"
                  placeholder="Como a turma te chama"
                  value={nickname}
                  onChange={(e) => onNicknameChange(e.target.value)}
                  maxLength={60}
                />
              </label>

              <div className="field">
                <label className="field-label" htmlFor="quick-room">
                  Sala avulsa
                  <span className="field-hint">Todos entram com o mesmo nome</span>
                </label>
                <div className="input-row">
                  <input
                    id="quick-room"
                    className="input"
                    value={roomCode}
                    onChange={(e) => onRoomCodeChange(e.target.value)}
                    maxLength={48}
                    required
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    style={{ width: 40, height: 40 }}
                    title="Sortear outro nome"
                    aria-label="Sortear outro nome de sala"
                    onClick={onRandomRoom}
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
                  onChange={(e) => onRoomPasswordChange(e.target.value)}
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
              {joining ? 'Conectando...' : 'Entrar na sala avulsa'}
            </button>
          </form>

          <section className="lobby-card">
            <header className="lobby-head">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2>Histórico recente</h2>
                <span className="field-hint num">
                  <UserCheck size={12} style={{ verticalAlign: -2 }} /> Sincronizado
                </span>
              </div>
              <p>Salas avulsas que você acessou recentemente.</p>
            </header>

            {savedRooms.length === 0 ? (
              <div className="empty-note">
                Nenhuma sala avulsa salva ainda. Você também pode clicar no <strong>+</strong> na barra à esquerda para montar seu servidor estilo Discord.
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
                      onClick={() => onJoinQuickRoom(r.room_code, r.room_password || '', r.room_label)}
                    >
                      <span className="room-item-title">
                        <Hash size={13} color="var(--text-3)" />
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
                        onClick={() => onTogglePin(r)}
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
                        onClick={() => onRemoveRoom(r.room_code)}
                        title="Remover do histórico"
                        aria-label="Remover sala"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Lightweight Modals: Create Server / Join Invite / Create Channel */}
      {modalMode !== 'none' && (
        <div className="modal-backdrop" onClick={() => setModalMode('none')}>
          <div
            className="modal-card modal-compact"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            {modalMode === 'create-server' && (
              <form onSubmit={(e) => void submitCreateServer(e)} className="modal-body">
                <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>Criar servidor</h2>
                <p className="field-hint">
                  Já nasce com os canais Sala Principal, Jogos e Cinema + código de convite.
                </p>
                <label className="field">
                  <span className="field-label">Nome do servidor</span>
                  <input
                    className="input"
                    placeholder="Ex: Turma da Madruga"
                    value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    minLength={2}
                    maxLength={40}
                    autoFocus
                    required
                  />
                </label>

                <div className="field">
                  <span className="field-label">Cor do ícone</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {SERVER_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`color-swatch ${newServerColor === c ? 'selected' : ''}`}
                        style={{ background: c }}
                        onClick={() => setNewServerColor(c)}
                        aria-label={`Cor ${c}`}
                      />
                    ))}
                  </div>
                </div>

                {modalError && <div className="inline-error">{modalError}</div>}

                <div className="modal-foot" style={{ padding: 0, borderTop: 'none', background: 'transparent' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setModalMode('none')}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={modalBusy}>
                    {modalBusy ? 'Criando...' : 'Criar servidor'}
                  </button>
                </div>
              </form>
            )}

            {modalMode === 'join-invite' && (
              <form onSubmit={(e) => void submitJoinInvite(e)} className="modal-body">
                <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>
                  Entrar por convite
                </h2>
                <p className="field-hint">
                  Cole o código de convite que seu amigo copiou do servidor dele.
                </p>
                <label className="field">
                  <span className="field-label">Código do convite</span>
                  <input
                    className="input"
                    placeholder="Ex: A1B2C3D4"
                    value={inviteInput}
                    onChange={(e) => setInviteInput(e.target.value.toUpperCase())}
                    maxLength={24}
                    autoFocus
                    required
                  />
                </label>
                {modalError && <div className="inline-error">{modalError}</div>}
                <div className="modal-foot" style={{ padding: 0, borderTop: 'none', background: 'transparent' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setModalMode('none')}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={modalBusy}>
                    {modalBusy ? 'Entrando...' : 'Entrar no servidor'}
                  </button>
                </div>
              </form>
            )}

            {modalMode === 'create-channel' && (
              <form onSubmit={(e) => void submitCreateChannel(e)} className="modal-body">
                <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>
                  Novo canal em {activeServer?.name}
                </h2>
                <label className="field">
                  <span className="field-label">Nome do canal</span>
                  <input
                    className="input"
                    placeholder="Ex: Valorant Ranked"
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    minLength={1}
                    maxLength={36}
                    autoFocus
                    required
                  />
                </label>
                <div className="field">
                  <span className="field-label">Tipo</span>
                  <div className="segmented">
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={newChannelKind === 'stream'}
                      onClick={() => setNewChannelKind('stream')}
                    >
                      Tela
                    </button>
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={newChannelKind === 'game'}
                      onClick={() => setNewChannelKind('game')}
                    >
                      Jogo
                    </button>
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={newChannelKind === 'movie'}
                      onClick={() => setNewChannelKind('movie')}
                    >
                      Filme
                    </button>
                  </div>
                </div>
                {modalError && <div className="inline-error">{modalError}</div>}
                <div className="modal-foot" style={{ padding: 0, borderTop: 'none', background: 'transparent' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setModalMode('none')}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={modalBusy}>
                    {modalBusy ? 'Criando...' : 'Adicionar canal'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

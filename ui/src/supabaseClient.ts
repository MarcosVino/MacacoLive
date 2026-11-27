import { createClient } from '@supabase/supabase-js';

// Publishable key for the MacacoLive Supabase project (safe for frontend; protected by Postgres RLS)
const SUPABASE_URL = 'https://vnraonmtmvxqkcaefkyz.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_LEHXzAr5fHvpmND9G7uJ6w_MPnibo0_';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'macacolive_auth_v1',
  },
});

export interface SavedRoomRecord {
  id?: number;
  user_id?: string;
  room_code: string;
  room_label: string;
  room_password: string;
  is_pinned: boolean;
  last_joined_at: string;
}

/**
 * Allows friends to register/sign in with either a real email OR a short username (e.g. "vinao")
 * mapped deterministically to a clean synthetic domain so nobody needs email verification hassle
 * unless they enter a real email.
 */
export function normalizeAuthEmail(identifier: string): {
  email: string;
  isSynthetic: boolean;
} {
  const clean = identifier.trim().toLowerCase();
  if (clean.includes('@')) {
    return { email: clean, isSynthetic: false };
  }
  const safeUser = clean.replace(/[^a-z0-9._-]/g, '');
  return {
    email: `${safeUser}@users.macacolive.local`,
    isSynthetic: true,
  };
}

export async function fetchUserProfileAndRooms(userId: string): Promise<{
  nickname: string | null;
  rooms: SavedRoomRecord[];
}> {
  const [{ data: profile }, { data: rooms }] = await Promise.all([
    supabase.from('profiles').select('nickname').eq('id', userId).maybeSingle(),
    supabase
      .from('saved_rooms')
      .select('id, room_code, room_label, room_password, is_pinned, last_joined_at')
      .eq('user_id', userId)
      .order('is_pinned', { ascending: false })
      .order('last_joined_at', { ascending: false })
      .limit(24),
  ]);

  return {
    nickname: profile?.nickname || null,
    rooms: (rooms as SavedRoomRecord[]) || [],
  };
}

export async function upsertSavedRoom(
  userId: string,
  room: {
    room_code: string;
    room_label?: string;
    room_password?: string;
    is_pinned?: boolean;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from('saved_rooms').upsert(
    {
      user_id: userId,
      room_code: room.room_code.trim(),
      room_label: (room.room_label ?? room.room_code).trim(),
      room_password: room.room_password ?? '',
      ...(typeof room.is_pinned === 'boolean' ? { is_pinned: room.is_pinned } : {}),
      last_joined_at: now,
    },
    { onConflict: 'user_id,room_code' }
  );
}

export async function toggleRoomPin(
  userId: string,
  roomCode: string,
  isPinned: boolean
): Promise<void> {
  await supabase
    .from('saved_rooms')
    .update({ is_pinned: isPinned })
    .eq('user_id', userId)
    .eq('room_code', roomCode);
}

export async function removeSavedRoom(
  userId: string,
  roomCode: string
): Promise<void> {
  await supabase
    .from('saved_rooms')
    .delete()
    .eq('user_id', userId)
    .eq('room_code', roomCode);
}

export async function updateNickname(
  userId: string,
  nickname: string
): Promise<void> {
  const clean = nickname.trim();
  if (!clean) return;
  await supabase.from('profiles').upsert({
    id: userId,
    nickname: clean,
    updated_at: new Date().toISOString(),
  });
}

export interface ServerChannelRecord {
  id: string;
  server_id: string;
  name: string;
  channel_kind: 'stream' | 'game' | 'movie';
  room_code: string;
  position: number;
  created_by: string | null;
  created_at: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  accent_color: string;
  invite_code: string;
  owner_id: string;
  created_at: string;
  channels: ServerChannelRecord[];
}

export interface ServerMemberRecord {
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  nickname: string;
  joined_at: string;
}

export interface ChannelPresenceEntry {
  userId: string;
  nickname: string;
  channelRoomCode: string | null;
  isStreaming: boolean;
  updatedAt: number;
}

export async function fetchUserServers(): Promise<ServerRecord[]> {
  const { data: servers, error } = await supabase
    .from('servers')
    .select('id, name, accent_color, invite_code, owner_id, created_at')
    .order('created_at', { ascending: true });

  if (error || !servers || servers.length === 0) return [];

  const serverIds = servers.map((s) => s.id);
  const { data: channels } = await supabase
    .from('server_channels')
    .select('id, server_id, name, channel_kind, room_code, position, created_by, created_at')
    .in('server_id', serverIds)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });

  const byServer = new Map<string, ServerChannelRecord[]>();
  for (const ch of (channels as ServerChannelRecord[]) || []) {
    const arr = byServer.get(ch.server_id) || [];
    arr.push(ch);
    byServer.set(ch.server_id, arr);
  }

  return servers.map((s) => ({
    ...s,
    channels: byServer.get(s.id) || [],
  }));
}

export async function createServerWithChannels(
  name: string,
  accentColor = '#f5c842'
): Promise<ServerRecord> {
  const { data, error } = await supabase.rpc('create_server_with_channels', {
    p_name: name.trim(),
    p_accent_color: accentColor,
  });
  if (error || !data) {
    throw new Error(error?.message || 'Não foi possível criar o servidor.');
  }
  const all = await fetchUserServers();
  const created = all.find((s) => s.id === data.id);
  if (!created) throw new Error('Servidor criado, mas não foi possível carregar os canais.');
  return created;
}

export async function joinServerByInvite(inviteCode: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase.rpc('join_server_by_invite', {
    p_invite_code: inviteCode.trim(),
  });
  if (error || !data) {
    throw new Error(error?.message || 'Convite inválido.');
  }
  return { id: data.id, name: data.name };
}

export async function createServerChannel(
  serverId: string,
  name: string,
  kind: 'stream' | 'game' | 'movie',
  userId: string,
  position: number
): Promise<ServerChannelRecord> {
  const cleanName = name.trim();
  const slug = cleanName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 14);
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const roomCode = `srv-${serverId.slice(0, 6)}-${slug || 'canal'}-${rand}`;

  const { data, error } = await supabase
    .from('server_channels')
    .insert({
      server_id: serverId,
      name: cleanName,
      channel_kind: kind,
      room_code: roomCode,
      position,
      created_by: userId,
    })
    .select('id, server_id, name, channel_kind, room_code, position, created_by, created_at')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Não foi possível criar o canal.');
  }
  return data as ServerChannelRecord;
}

export async function deleteServerChannel(channelId: string): Promise<void> {
  const { error } = await supabase.from('server_channels').delete().eq('id', channelId);
  if (error) throw new Error(error.message);
}

export async function leaveOrDeleteServer(server: ServerRecord, userId: string): Promise<void> {
  if (server.owner_id === userId) {
    const { error } = await supabase.from('servers').delete().eq('id', server.id);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase
    .from('server_members')
    .delete()
    .eq('server_id', server.id)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

export async function fetchServerRoster(serverId: string): Promise<ServerMemberRecord[]> {
  const { data, error } = await supabase.rpc('list_server_roster', {
    p_server_id: serverId,
  });
  if (error || !data) return [];
  return data as ServerMemberRecord[];
}

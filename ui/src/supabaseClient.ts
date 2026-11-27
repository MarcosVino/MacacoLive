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

/**
 * Supabase leaderboard integration.
 *
 * Requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.
 * The anon key is safe to expose when Row-Level Security (RLS) policies
 * restrict it to SELECT + INSERT only (see SETUP.md for the SQL).
 */

import { createClient } from '@supabase/supabase-js'
// Note: submitScore is intentionally not exported — use submitBestScore instead
// checkNameExists is exported so the name screen can prevent duplicate names

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

let _client = null

if (url && key) {
  _client = createClient(url, key)
}

/** True when Supabase env vars are present. */
export function isConfigured() {
  return _client !== null
}

/**
 * Submit a score only if it beats the player's current best.
 * Returns { submitted: true, isNewBest: true } if inserted,
 *         { submitted: false, currentBest: number } if not better.
 * @param {string} playerName  - max 20 chars
 * @param {number} score       - non-negative integer
 */
export async function submitBestScore(playerName, score) {
  if (!_client) throw new Error('Supabase is not configured.')

  const name = playerName.trim().slice(0, 20)
  if (!name) throw new Error('Player name cannot be empty.')
  if (!Number.isInteger(score) || score < 0) throw new Error('Invalid score.')

  // Fetch this player's current best
  const { data, error: fetchErr } = await _client
    .from('leaderboard')
    .select('score')
    .eq('player_name', name)
    .order('score', { ascending: false })
    .limit(1)

  if (fetchErr) throw fetchErr

  const currentBest = data && data.length > 0 ? data[0].score : null

  if (currentBest !== null && score <= currentBest) {
    return { submitted: false, currentBest }
  }

  // Always insert a new row — works with SELECT + INSERT-only RLS.
  // getTopScores deduplicates per player, so duplicates are never shown.
  const { error: insertErr } = await _client
    .from('leaderboard')
    .insert({ player_name: name, score })

  if (insertErr) throw insertErr

  return { submitted: true, isNewBest: true, previousBest: currentBest }
}

/**
 * Check whether a player name already exists in the leaderboard.
 * Returns true if taken, false otherwise (or if Supabase is not configured).
 * @param {string} playerName
 * @returns {Promise<boolean>}
 */
export async function checkNameExists(playerName) {
  if (!_client) return false

  const name = playerName.trim().slice(0, 20)
  if (!name) return false

  const { data, error } = await _client
    .from('leaderboard')
    .select('player_name')
    .eq('player_name', name)
    .limit(1)

  if (error) return false
  return data !== null && data.length > 0
}

/**
 * Fetch the top N scores ordered by score descending.
 * @param {number} limit  - default 10
 * @returns {Array<{ player_name, score, created_at }>}
 */
export async function getTopScores(limit = 10) {
  if (!_client) return []

  // Fetch extra rows to absorb per-player duplicates, then deduplicate.
  const { data, error } = await _client
    .from('leaderboard')
    .select('player_name, score, created_at')
    .order('score', { ascending: false })
    .limit(limit * 20)

  if (error) throw error
  if (!data) return []

  // Keep only the highest score row per player (data is already sorted desc).
  const seen = new Set()
  const deduped = []
  for (const row of data) {
    if (!seen.has(row.player_name)) {
      seen.add(row.player_name)
      deduped.push(row)
    }
  }
  return deduped.slice(0, limit)
}

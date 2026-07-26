/**
 * sync.js — Supabase Shared Sync
 */

let syncTimeout = null;

export function hasSync() {
  try {
    const settings = JSON.parse(localStorage.getItem('sehat.settings') || '{}');
    return !!(settings.syncUrl && settings.syncKey);
  } catch {
    return false;
  }
}

export function queueSync() {
  if (!hasSync()) return;
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    syncNow().catch(() => {});
  }, 2000);
}

export async function syncNow() {
  if (!navigator.onLine) {
    updateStatus('Offline — sync pending', 'warn');
    return { success: false, error: 'Offline' };
  }

  let settings;
  try {
    settings = JSON.parse(localStorage.getItem('sehat.settings') || '{}');
  } catch {
    return { success: false, error: 'Failed to read settings' };
  }

  const { syncUrl, syncKey } = settings;
  if (!syncUrl || !syncKey) {
    return { success: false, error: 'Sync credentials not configured' };
  }

  if (syncKey.trim().length < 10) {
    return { success: false, error: 'Supabase API key is too short or invalid. Please copy the full anon/service_role key.' };
  }

  updateStatus('Syncing…', 'info');

  let records = [];
  try {
    records = JSON.parse(localStorage.getItem('sehat.records') || '[]');
  } catch {}

  // Standardize record dirty flags and stamps
  records = records.map(r => {
    if (r._dirty === undefined) {
      r._dirty = true;
    }
    if (!r.updatedAt) {
      r.updatedAt = r.screenedAt || new Date().toISOString();
    }
    return r;
  });

  try {
    const response = await fetch(`${syncUrl}/rest/v1/rpc/sync_records`, {
      method: 'POST',
      headers: {
        'apikey': syncKey,
        'Authorization': `Bearer ${syncKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-dup'
      },
      body: JSON.stringify({ local_records: records })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const remoteRecords = await response.json();
    if (Array.isArray(remoteRecords)) {
      // Clear dirty flags of synced records
      const cleanRecords = remoteRecords.map(r => ({ ...r, _dirty: false }));
      localStorage.setItem('sehat.records', JSON.stringify(cleanRecords));
      
      settings.lastSyncedAt = new Date().toISOString();
      localStorage.setItem('sehat.settings', JSON.stringify(settings));

      updateStatus(`Last sync: ${new Date().toLocaleTimeString()}`, 'info');

      // Dispatch sync-complete event to re-render the view
      window.dispatchEvent(new CustomEvent('sehat-sync-complete'));
      return { success: true };
    } else {
      throw new Error('Invalid server response format');
    }
  } catch (err) {
    updateStatus('Sync failed', 'warn');
    return { success: false, error: err.message };
  }
}

function updateStatus(msg, kind) {
  const bar = document.querySelector('#statusbar');
  if (bar) {
    bar.textContent = msg;
    bar.className = 'statusbar' + (kind === 'warn' ? ' statusbar--warn' : ' statusbar--info');
    bar.hidden = false;
    clearTimeout(window._syncStatusTimeout);
    window._syncStatusTimeout = setTimeout(() => {
      bar.hidden = true;
    }, 5000);
  }
}

/**
 * Gmail API helpers for fetching inbox messages with audio attachments
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/aiff',
  'audio/x-aiff',
  'audio/aif',
  'audio/flac',
  'audio/ogg',
  'audio/webm',
];

/**
 * Check if a MIME type is an audio format we support
 */
function isAudioMimeType(mimeType) {
  if (!mimeType) return false;
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  return AUDIO_MIME_TYPES.includes(normalized);
}

/**
 * Extract audio attachments from a Gmail message
 */
function extractAudioAttachments(message) {
  const attachments = [];
  const subject = getHeader(message, 'Subject') || 'Untitled';
  const date = getHeader(message, 'Date') || '';

  function walkParts(parts, depth = 0) {
    if (!parts) return;
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId && isAudioMimeType(part.mimeType)) {
        attachments.push({
          messageId: message.id,
          threadId: message.threadId,
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          subject,
          date,
          mimeType: part.mimeType,
        });
      }
      if (part.parts) {
        walkParts(part.parts, depth + 1);
      }
    }
  }

  if (message.payload?.parts) {
    walkParts(message.payload.parts);
  } else if (message.payload?.body?.attachmentId && message.payload?.filename) {
    if (isAudioMimeType(message.payload.mimeType)) {
      attachments.push({
        messageId: message.id,
        threadId: message.threadId,
        attachmentId: message.payload.body.attachmentId,
        filename: message.payload.filename,
        subject,
        date,
        mimeType: message.payload.mimeType,
      });
    }
  }

  return attachments;
}

function getHeader(message, name) {
  const headers = message.payload?.headers || [];
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

/**
 * List inbox messages with attachments (paginated - fetches all matching messages)
 */
async function listInboxMessagesWithAttachments(accessToken, maxTotal = 500, searchQuery = '') {
  const q = searchQuery ? `has:attachment ${searchQuery}`.trim() : 'has:attachment';
  const allMessages = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      labelIds: 'INBOX',
      q,
      maxResults: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${GMAIL_API_BASE}/messages?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gmail API error: ${res.status}`);
    }

    const data = await res.json();
    const messages = data.messages || [];
    allMessages.push(...messages);

    pageToken = data.nextPageToken || null;
    if (maxTotal > 0 && allMessages.length >= maxTotal) break;
  } while (pageToken);

  return maxTotal > 0 ? allMessages.slice(0, maxTotal) : allMessages;
}

/**
 * Get full message details
 */
async function getMessage(accessToken, messageId) {
  const res = await fetch(
    `${GMAIL_API_BASE}/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gmail API error: ${res.status}`);
  }

  return res.json();
}

/**
 * Get attachment data - returns { base64, mimeType } for offscreen to create blob
 */
async function getAttachmentData(accessToken, messageId, attachmentId, mimeType = 'audio/mpeg') {
  const res = await fetch(
    `${GMAIL_API_BASE}/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gmail API error: ${res.status}`);
  }

  const data = await res.json();
  const base64 = data.data;

  if (!base64) {
    throw new Error('No attachment data');
  }

  return { base64, mimeType };
}

/**
 * Build queue of audio loops from inbox, calling onAttachments for each batch as they load.
 * First samples appear immediately so playback can start while rest load in background.
 */
async function buildAudioQueueStreaming(accessToken, searchQuery, onAttachments, maxMessages = 500) {
  const rawRefs = await listInboxMessagesWithAttachments(accessToken, maxMessages, searchQuery);
  const seenIds = new Set();
  const messageRefs = rawRefs.filter((ref) => {
    if (seenIds.has(ref.id)) return false;
    seenIds.add(ref.id);
    return true;
  });

  for (const ref of messageRefs) {
    let message;
    try {
      message = await getMessage(accessToken, ref.id);
    } catch (e) {
      try {
        message = await getMessage(accessToken, ref.id);
      } catch (retryErr) {
        console.warn('Failed to fetch message', ref.id, retryErr);
        continue;
      }
    }
    const attachments = extractAudioAttachments(message);
    if (attachments.length > 0) {
      onAttachments(attachments);
    }
  }
}

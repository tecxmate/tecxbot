export async function sendFacebookMessage(recipientId: string, text: string, pageAccessToken = process.env.FB_PAGE_ACCESS_TOKEN) {
  if (!pageAccessToken) throw new Error('FB_PAGE_ACCESS_TOKEN is not configured');
  const response = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text: text.slice(0, 1900) },
    }),
  });
  if (!response.ok) throw new Error(`Facebook Send API failed: ${response.status} ${await response.text()}`);
}

export async function sendFacebookUpdate(recipientId: string, text: string, pageAccessToken = process.env.FB_PAGE_ACCESS_TOKEN) {
  if (!pageAccessToken) throw new Error('FB_PAGE_ACCESS_TOKEN is not configured');
  const response = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'UPDATE',
      message: { text: text.slice(0, 1900) },
    }),
  });
  if (!response.ok) throw new Error(`Facebook Send API update failed: ${response.status} ${await response.text()}`);
}

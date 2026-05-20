export type LineSource = { userId?: string; type: 'user' | 'group' | 'room'; groupId?: string; roomId?: string };

export type LineMessage =
  | { type: 'text'; id: string; text: string; mention?: { mentionees?: LineMentionee[] } }
  | { type: 'audio' | 'video' | 'file'; id: string; duration?: number; fileName?: string; fileSize?: number }
  | { type: 'image' | 'location' | 'sticker' | 'unknown'; id: string };

export type LineMentionee = {
  index: number;
  length: number;
  type?: string;
  userId?: string;
  isSelf?: boolean;
};

export type LineEvent =
  | { type: 'message'; replyToken: string; source?: LineSource; message: LineMessage }
  | { type: 'postback'; replyToken: string; source?: LineSource; postback?: { data?: string } }
  | { type: 'follow' | 'join' | 'memberJoined'; replyToken: string; source?: LineSource }
  | { type: string; replyToken?: string; source?: LineSource };

export type LineWebhookPayload = { events?: LineEvent[] };

export type LineQuickReplyAction =
  | { type: 'message'; label: string; text: string }
  | { type: 'postback'; label: string; data: string }
  | { type: 'uri'; label: string; uri: string };

export type LineTextReply = { type: 'text'; text: string; quickReply?: { items: Array<{ type: 'action'; action: LineQuickReplyAction }> } };
export type LineImageReply = { type: 'image'; originalContentUrl: string; previewImageUrl: string };

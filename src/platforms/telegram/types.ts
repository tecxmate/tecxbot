export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type TelegramChat = { id: number; type: string };

export type TelegramFile = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
  duration?: number;
};

export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: { id: number; first_name?: string };
  text?: string;
  voice?: TelegramFile;
  audio?: TelegramFile;
  video?: TelegramFile;
  video_note?: TelegramFile;
  document?: TelegramFile;
};

export type TelegramCallbackQuery = {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string;
};

export type TelegramInlineButton = { text: string; callback_data?: string; url?: string };

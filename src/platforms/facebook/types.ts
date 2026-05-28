export type FacebookWebhookPayload = {
  object?: string;
  entry?: FacebookEntry[];
};

export type FacebookEntry = {
  id?: string;
  time?: number;
  messaging?: FacebookMessagingEvent[];
};

export type FacebookMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
  };
  postback?: {
    title?: string;
    payload?: string;
  };
};

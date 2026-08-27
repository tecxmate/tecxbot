// Meta WhatsApp Business Platform (Cloud API) webhook shapes.
// Only the fields the connector reads are modelled; the payload carries more.

export type WhatsappContact = {
  wa_id?: string;
  profile?: { name?: string };
};

export type WhatsappMessage = {
  id?: string;
  /** Present on inbound messages: the client's WhatsApp id. */
  from?: string;
  /** Present on business echoes: the recipient's WhatsApp id. */
  to?: string;
  /** Unix seconds, as a string. */
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  audio?: { voice?: boolean };
  document?: { caption?: string; filename?: string };
  sticker?: Record<string, unknown>;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?: { emoji?: string; message_id?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  errors?: Array<{ title?: string; message?: string }>;
};

export type WhatsappChangeValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WhatsappContact[];
  messages?: WhatsappMessage[];
  /** Messages the business sent, when the `message_echoes` field is subscribed. */
  message_echoes?: WhatsappMessage[];
  statuses?: Array<Record<string, unknown>>;
};

export type WhatsappChange = { field?: string; value?: WhatsappChangeValue };

export type WhatsappWebhookPayload = {
  object?: string;
  entry?: Array<{ id?: string; changes?: WhatsappChange[] }>;
};

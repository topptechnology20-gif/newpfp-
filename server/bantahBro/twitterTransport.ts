import crypto from "crypto";

type TwitterCredentials = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

type TwitterHttpMethod = "GET" | "POST";

type TwitterQuery = Record<string, string | number | boolean | null | undefined>;

export type TwitterPostResult = {
  id: string;
  text: string;
  raw: unknown;
};

export type TwitterUser = {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
};

export type TwitterTweet = {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  public_metrics?: Record<string, number>;
};

const TWITTER_CREATE_TWEET_URL = "https://api.twitter.com/2/tweets";
const TWITTER_UPLOAD_MEDIA_URL = "https://upload.twitter.com/1.1/media/upload.json";
const TWITTER_REQUEST_TIMEOUT_MS = Number(process.env.BANTAHBRO_TWITTER_REQUEST_TIMEOUT_MS || 15_000);

function readCredential(name: string) {
  return String(process.env[name] || "").trim();
}

function getTwitterCredentials(): TwitterCredentials | null {
  const credentials = {
    apiKey: readCredential("TWITTER_API_KEY"),
    apiSecret: readCredential("TWITTER_API_SECRET"),
    accessToken: readCredential("TWITTER_ACCESS_TOKEN"),
    accessTokenSecret: readCredential("TWITTER_ACCESS_TOKEN_SECRET"),
  };

  return Object.values(credentials).every(Boolean) ? credentials : null;
}

function percentEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeQuery(query?: TwitterQuery) {
  return Object.fromEntries(
    Object.entries(query || {})
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

function buildUrl(url: string, query?: TwitterQuery) {
  const cleanQuery = normalizeQuery(query);
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(cleanQuery)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function buildOAuthHeader(
  method: TwitterHttpMethod,
  url: string,
  credentials: TwitterCredentials,
  requestParams: TwitterQuery = {},
) {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const signatureParams = {
    ...normalizeQuery(requestParams),
    ...oauthParams,
  };

  const parameterString = Object.entries(signatureParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");

  const signatureBase = [
    method,
    percentEncode(url),
    percentEncode(parameterString),
  ].join("&");
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(
    credentials.accessTokenSecret,
  )}`;
  const oauthSignature = crypto
    .createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");

  return `OAuth ${Object.entries({
    ...oauthParams,
    oauth_signature: oauthSignature,
  })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ")}`;
}

export function getTwitterTransportStatus() {
  const credentials = getTwitterCredentials();
  return {
    configured: Boolean(credentials),
    missing: credentials
      ? []
      : [
          "TWITTER_API_KEY",
          "TWITTER_API_SECRET",
          "TWITTER_ACCESS_TOKEN",
          "TWITTER_ACCESS_TOKEN_SECRET",
        ].filter((name) => !readCredential(name)),
  };
}

async function twitterRequest<T>(
  method: TwitterHttpMethod,
  url: string,
  options: {
    query?: TwitterQuery;
    body?: unknown;
    oauthParams?: TwitterQuery;
  } = {},
): Promise<T> {
  const credentials = getTwitterCredentials();
  if (!credentials) {
    throw new Error("Twitter transport is not configured.");
  }

  const requestUrl = buildUrl(url, options.query);
  const response = await fetch(requestUrl, {
    method,
    signal: AbortSignal.timeout(TWITTER_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: buildOAuthHeader(method, url, credentials, {
        ...normalizeQuery(options.query),
        ...normalizeQuery(options.oauthParams),
      }),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "detail" in payload
        ? String((payload as { detail?: unknown }).detail)
        : payload && typeof payload === "object" && "title" in payload
          ? String((payload as { title?: unknown }).title)
          : `Twitter API request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

export async function getAuthenticatedTwitterUser(): Promise<TwitterUser> {
  const payload = await twitterRequest<{ data?: TwitterUser }>(
    "GET",
    "https://api.twitter.com/2/users/me",
    {
      query: {
        "user.fields": "id,name,username,profile_image_url",
      },
    },
  );
  if (!payload.data?.id) {
    throw new Error("Twitter user lookup did not return a user id.");
  }
  return payload.data;
}

export async function getTwitterUserMentions(
  userId: string,
  options: { sinceId?: string | null; maxResults?: number } = {},
) {
  const payload = await twitterRequest<{
    data?: TwitterTweet[];
    meta?: { newest_id?: string; oldest_id?: string; result_count?: number };
  }>("GET", `https://api.twitter.com/2/users/${encodeURIComponent(userId)}/mentions`, {
    query: {
      max_results: Math.max(5, Math.min(100, options.maxResults || 10)),
      ...(options.sinceId ? { since_id: options.sinceId } : {}),
      expansions: "author_id,referenced_tweets.id",
      "tweet.fields": "author_id,conversation_id,created_at,entities,public_metrics,referenced_tweets",
    },
  });
  return {
    tweets: payload.data || [],
    meta: payload.meta || {},
  };
}

export async function searchRecentTweets(
  query: string,
  options: { sinceId?: string | null; maxResults?: number } = {},
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { tweets: [] as TwitterTweet[], meta: {} };
  }

  const payload = await twitterRequest<{
    data?: TwitterTweet[];
    meta?: { newest_id?: string; oldest_id?: string; result_count?: number };
  }>("GET", "https://api.twitter.com/2/tweets/search/recent", {
    query: {
      query: normalizedQuery,
      max_results: Math.max(10, Math.min(100, options.maxResults || 10)),
      ...(options.sinceId ? { since_id: options.sinceId } : {}),
      expansions: "author_id,referenced_tweets.id",
      "tweet.fields": "author_id,conversation_id,created_at,entities,public_metrics,referenced_tweets",
    },
  });

  return {
    tweets: payload.data || [],
    meta: payload.meta || {},
  };
}

export async function postTweet(
  text: string,
  options: {
    replyToTweetId?: string | null;
    quoteTweetId?: string | null;
    mediaIds?: string[];
  } = {},
): Promise<TwitterPostResult> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error("Tweet text is required.");
  }
  if (normalizedText.length > 280) {
    throw new Error(`Tweet text is too long (${normalizedText.length}/280).`);
  }

  const payload = await twitterRequest<{ data?: { id?: unknown; text?: unknown } }>(
    "POST",
    TWITTER_CREATE_TWEET_URL,
    {
      body: {
        text: normalizedText,
        ...(options.replyToTweetId
          ? { reply: { in_reply_to_tweet_id: options.replyToTweetId } }
          : {}),
        ...(options.quoteTweetId ? { quote_tweet_id: options.quoteTweetId } : {}),
        ...(options.mediaIds?.length ? { media: { media_ids: options.mediaIds } } : {}),
      },
    },
  );

  const data =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: { id?: unknown; text?: unknown } }).data
      : null;
  const id = typeof data?.id === "string" ? data.id : "";
  const postedText = typeof data?.text === "string" ? data.text : normalizedText;

  if (!id) {
    throw new Error("Twitter API response did not include a tweet id.");
  }

  return {
    id,
    text: postedText,
    raw: payload,
  };
}

export async function uploadTweetMedia(data: Buffer, mimeType = "image/png") {
  const credentials = getTwitterCredentials();
  if (!credentials) {
    throw new Error("Twitter transport is not configured.");
  }
  if (!data.length) {
    throw new Error("Media data is required.");
  }

  const form = new FormData();
  const extension = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
  form.append(
    "media",
    new Blob([new Uint8Array(data)], { type: mimeType }),
    `bantahbro-battle.${extension}`,
  );

  const response = await fetch(TWITTER_UPLOAD_MEDIA_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TWITTER_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: buildOAuthHeader("POST", TWITTER_UPLOAD_MEDIA_URL, credentials),
    },
    body: form,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `Twitter media upload failed with ${response.status}`;
    throw new Error(message);
  }

  const mediaId =
    payload && typeof payload === "object" && "media_id_string" in payload
      ? String((payload as { media_id_string?: unknown }).media_id_string || "")
      : "";
  if (!mediaId) {
    throw new Error("Twitter media upload response did not include a media id.");
  }

  return {
    mediaId,
    raw: payload,
  };
}

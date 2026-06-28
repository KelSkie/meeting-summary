export const config = {
  runtime: "edge",
};

const GROQ_TRANSCRIPTION_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function readRateLimit(headers) {
  return {
    requestsLimit: headers.get("x-ratelimit-limit-requests") || "",
    requestsRemaining: headers.get("x-ratelimit-remaining-requests") || "",
    requestsReset: headers.get("x-ratelimit-reset-requests") || "",
    tokensLimit: headers.get("x-ratelimit-limit-tokens") || "",
    tokensRemaining: headers.get("x-ratelimit-remaining-tokens") || "",
    tokensReset: headers.get("x-ratelimit-reset-tokens") || "",
  };
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return json(
      { error: "Server chưa cấu hình GROQ_API_KEY." },
      { status: 500 },
    );
  }

  let incomingForm;
  try {
    incomingForm = await request.formData();
  } catch {
    return json({ error: "Request audio không hợp lệ." }, { status: 400 });
  }

  const file = incomingForm.get("file");
  if (!(file instanceof File) || !file.size) {
    return json({ error: "Thiếu file audio để transcribe." }, { status: 400 });
  }

  const language = String(incomingForm.get("language") || "").trim();
  const groqForm = new FormData();
  groqForm.append("file", file, file.name || "meeting.webm");
  groqForm.append("model", "whisper-large-v3");
  groqForm.append("response_format", "json");
  if (/^[a-z]{2,3}$/i.test(language)) {
    groqForm.append("language", language.toLowerCase());
  }

  const groqResponse = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: groqForm,
  });

  const rawText = await groqResponse.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { message: rawText };
  }
  const rateLimit = readRateLimit(groqResponse.headers);
  const retryAfter = groqResponse.headers.get("retry-after") || "";

  if (!groqResponse.ok) {
    return json(
      {
        error:
          payload?.error?.message ||
          payload?.message ||
          "Groq transcription thất bại.",
        rateLimit,
        retryAfter,
      },
      { status: groqResponse.status },
    );
  }

  return json({
    text: payload.text || "",
    rateLimit,
    retryAfter,
  });
}

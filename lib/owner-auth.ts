import { env } from "cloudflare:workers";
import { verifyPassword } from "./security";

const COOKIE_NAME = "__Host-pactline_owner";
const SESSION_HOURS = 12;

type OwnerEnvironment = {
  OWNER_EMAIL?: string;
  OWNER_PASSWORD_HASH?: string;
  OWNER_SESSION_SECRET?: string;
};

function ownerEnvironment(): OwnerEnvironment {
  return env as unknown as OwnerEnvironment;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function signature(value: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function cookieValue(cookieHeader: string | null) {
  if (!cookieHeader) return null;
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1) ?? null;
}

export async function ownerFromSession(cookieHeader: string | null) {
  const secret = ownerEnvironment().OWNER_SESSION_SECRET;
  const token = cookieValue(cookieHeader);
  if (!secret || !token) return null;

  const [expiresText, tokenSignature] = token.split(".");
  const expiresAt = Number(expiresText);
  if (!expiresText || !tokenSignature || !Number.isSafeInteger(expiresAt)) return null;
  if (expiresAt <= Date.now() || expiresAt > Date.now() + SESSION_HOURS * 60 * 60 * 1000) return null;
  const expected = await signature(expiresText, secret);
  if (!constantTimeEqual(expected, tokenSignature)) return null;

  const email = ownerEnvironment().OWNER_EMAIL?.trim() || "owner@pactline.local";
  return {
    userId: "pactline-contract-owner",
    displayName: "Contract Owner",
    email,
    fullName: "Contract Owner",
  };
}

export async function verifyOwnerPassword(password: string) {
  const stored = ownerEnvironment().OWNER_PASSWORD_HASH;
  if (!stored || typeof password !== "string") return false;
  return verifyPassword(password, stored);
}

export async function createOwnerSessionCookie() {
  const secret = ownerEnvironment().OWNER_SESSION_SECRET;
  if (!secret) throw new Error("Owner session secret is not configured");
  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const expiresText = String(expiresAt);
  const token = `${expiresText}.${await signature(expiresText, secret)}`;
  return `${COOKIE_NAME}=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearOwnerSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function safeOwnerReturnPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local" || url.pathname.startsWith("/owner/login") || url.pathname.startsWith("/api/owner")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

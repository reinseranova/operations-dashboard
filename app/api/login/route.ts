import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  isPasswordCorrect,
  sessionTokenFor,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let password = "";
  try {
    const body = (await req.json()) as { password?: string };
    password = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!process.env.DASHBOARD_PASSWORD) {
    return NextResponse.json(
      { error: "Server is missing DASHBOARD_PASSWORD." },
      { status: 500 },
    );
  }

  if (!isPasswordCorrect(password)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, sessionTokenFor(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}

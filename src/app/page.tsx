"use client";

import { ChatWindow } from "@/components/ChatWindow";

/**
 * The chat is entirely client-driven (sessionStorage + SSE), so the page is a
 * client component with no server data; under `cacheComponents` it prerenders
 * to a static shell.
 */
export default function Home() {
  return <ChatWindow />;
}

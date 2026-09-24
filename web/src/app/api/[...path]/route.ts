import type { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyToApi(req);
}

export async function POST(req: NextRequest) {
  return proxyToApi(req);
}

import type { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy";

export const dynamic = "force-dynamic";

// Run the proxy in Cleveland, next to the API in AWS us-east-2 (Ohio).
export const preferredRegion = "cle1";

export async function GET(req: NextRequest) {
  return proxyToApi(req);
}

export async function POST(req: NextRequest) {
  return proxyToApi(req);
}

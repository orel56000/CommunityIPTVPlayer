import { handleRestreamWebRequest } from "../restreamHandler";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

export default async function handler(request: Request): Promise<Response> {
  const response = await handleRestreamWebRequest(request);
  return response ?? new Response("Not found", { status: 404 });
}

import { request, type HttpResponse, type RequestBody, type RequestInput } from "../lib/request.ts";

export default async function post(input: RequestInput & RequestBody): Promise<HttpResponse> {
  if (input.json !== undefined && input.text !== undefined) throw new Error("INVALID_INPUT: pass either json or text, not both");
  if (input.contentType !== undefined && input.text === undefined) throw new Error("INVALID_INPUT: contentType applies to a text body only");
  const body: RequestBody = {};
  if (input.json !== undefined) body.json = input.json;
  if (input.text !== undefined) body.text = input.text;
  if (input.contentType !== undefined) body.contentType = input.contentType;
  return request("POST", input, body);
}

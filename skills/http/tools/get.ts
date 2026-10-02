import { request, type HttpResponse, type RequestInput } from "../lib/request.ts";

export default function get(input: RequestInput): Promise<HttpResponse> {
  return request("GET", input);
}

import { InputRecord } from "./types.ts";

export async function loadJsonTransactions(path: string): Promise<InputRecord[]> {
  const data = await Deno.readTextFile(path);
  const parsed = JSON.parse(data);
  if (!Array.isArray(parsed)) {
    throw new Error("Input JSON must be an array of transaction records");
  }
  return parsed as InputRecord[];
}

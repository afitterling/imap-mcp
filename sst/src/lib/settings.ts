import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc } from "./db.js";

const TABLE = () => Resource.OAuth.name;

async function get<T>(id: string): Promise<T | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
  return res.Item?.value as T | undefined;
}
async function set(id: string, value: unknown, userId?: string): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { id, value, userId } }));
}

/** Approval is ON unless this user has explicitly switched it off. */
export async function requireApproval(userId: string): Promise<boolean> {
  return (await get<boolean>(`config#approval#${userId}`)) !== false;
}
export function setRequireApproval(userId: string, value: boolean): Promise<void> {
  return set(`config#approval#${userId}`, value, userId);
}

export async function readJsonApiResponse<T>(
  response: Response,
  operationLabel: string,
): Promise<T> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();
  const isJson =
    contentType.includes("application/json") || contentType.includes("+json");

  if (!isJson) {
    throw new Error(unexpectedResponseMessage(response.status, operationLabel));
  }

  if (!body.trim()) {
    throw new Error(
      `HTTP ${response.status} — O servidor respondeu sem dados durante ${operationLabel}.`,
    );
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(
      `HTTP ${response.status} — O servidor retornou uma resposta JSON inválida durante ${operationLabel}.`,
    );
  }
}

export function unexpectedResponseMessage(
  status: number,
  operationLabel: string,
): string {
  if (status === 502) {
    return `HTTP 502 — O servidor interrompeu a resposta durante ${operationLabel}. Tente novamente em instantes.`;
  }
  if (status === 503) {
    return `HTTP 503 — O servidor está temporariamente indisponível durante ${operationLabel}. Tente novamente em instantes.`;
  }
  if (status === 504) {
    return `HTTP 504 — O servidor excedeu o tempo de resposta durante ${operationLabel}. Tente novamente.`;
  }
  return `HTTP ${status} — O servidor retornou uma resposta inesperada durante ${operationLabel}.`;
}

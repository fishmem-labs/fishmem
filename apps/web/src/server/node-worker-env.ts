export const env = process.env;

export function waitUntil(promise: Promise<unknown>) {
  void promise.catch((error) => {
    console.error("Background task failed", error);
  });
}

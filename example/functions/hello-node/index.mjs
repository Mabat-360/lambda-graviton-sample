// Pure JavaScript: the same zip runs on x86_64 and on arm64.
export const handler = async () => ({
  statusCode: 200,
  body: JSON.stringify({ message: 'hello', arch: process.arch }),
});

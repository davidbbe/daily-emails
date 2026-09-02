import { JWT } from "google-auth-library";

function stripWrappingQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function getServiceAccountCredentials() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL?.trim();
  let privateKey = process.env.GOOGLE_PRIVATE_KEY?.trim();
  if (!clientEmail || !privateKey) return null;

  // Vercel UI / dotenv may wrap the PEM in quotes and store literal \n.
  privateKey = stripWrappingQuotes(privateKey).replace(/\\n/g, "\n");
  return { clientEmail: stripWrappingQuotes(clientEmail), privateKey };
}

export function getGoogleCloudProjectId() {
  const fromEnv =
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCP_PROJECT_ID?.trim();
  if (fromEnv) return fromEnv;
  const creds = getServiceAccountCredentials();
  const domain = creds?.clientEmail.split("@")[1];
  const fromSa = domain?.replace(/\.iam\.gserviceaccount\.com$/, "");
  return fromSa || null;
}

export async function getGoogleAccessToken(
  scopes: string[],
): Promise<string | null> {
  const creds = getServiceAccountCredentials();
  if (!creds) return null;

  const client = new JWT({
    email: creds.clientEmail,
    key: creds.privateKey,
    scopes,
  });

  const token = await client.getAccessToken();
  return token.token ?? null;
}

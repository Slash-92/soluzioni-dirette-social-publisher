import process from "node:process";

const apiKey = process.env.BUFFER_API_KEY;
if (!apiKey) {
  console.error("BUFFER_API_KEY non configurata.");
  process.exit(1);
}

async function request(query, variables = {}) {
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      payload.errors?.map((error) => error.message).join("; ") ||
        `Buffer HTTP ${response.status}`,
    );
  }
  return payload.data;
}

const account = await request(`
  query Account {
    account {
      organizations { id name }
    }
  }
`);

const result = [];
for (const organization of account.account.organizations) {
  const data = await request(
    `
      query Channels($organizationId: OrganizationId!) {
        channels(input: { organizationId: $organizationId }) {
          id
          name
          service
        }
      }
    `,
    { organizationId: organization.id },
  );
  result.push({ organization, channels: data.channels });
}

console.log(JSON.stringify(result, null, 2));

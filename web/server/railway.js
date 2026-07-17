// railway.js — let the app register a new Courted account by writing
// COURTED_EMAIL_n / COURTED_PASSWORD_n into its own Railway service via the
// Railway GraphQL API.
//
// Auth: a Railway PROJECT token in RAILWAY_API_TOKEN (sent as Project-Access-Token).
// The project / environment / service IDs are auto-injected by Railway
// (RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID / RAILWAY_SERVICE_ID).
//
// NOTE: writing a variable triggers a service REDEPLOY — the running process
// only sees the new account after it restarts. The caller (UI) handles that by
// waiting for the account count to rise, then starting the sweep.

const API = 'https://backboard.railway.app/graphql/v2';

export function railwayEnabled() {
    return Boolean(
        process.env.RAILWAY_API_TOKEN &&
        process.env.RAILWAY_PROJECT_ID &&
        process.env.RAILWAY_ENVIRONMENT_ID &&
        process.env.RAILWAY_SERVICE_ID,
    );
}

async function gql(query, variables) {
    const res = await fetch(API, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Project-Access-Token': process.env.RAILWAY_API_TOKEN,
        },
        body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data;
}

/** Upsert several env vars in one call (one redeploy). vars = { NAME: value }. */
export async function upsertVariables(vars) {
    const input = {
        projectId: process.env.RAILWAY_PROJECT_ID,
        environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
        serviceId: process.env.RAILWAY_SERVICE_ID,
        variables: vars,
    };
    await gql('mutation($i: VariableCollectionUpsertInput!){ variableCollectionUpsert(input: $i) }', { i: input });
    return true;
}

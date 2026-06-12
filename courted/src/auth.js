// auth.js — authenticate to Courted via AWS Cognito (USER_PASSWORD_AUTH).
//
// The Courted web app signs in through AWS Cognito and then calls api.courted.io
// with an "Authorization: Bearer <AccessToken>" header. We replicate that sign-in
// over plain HTTP (no browser needed): one POST to the Cognito IDP returns the
// access token. Tokens last ~1 hour; we refresh proactively using the returned
// RefreshToken so long scrapes don't 401 mid-run.

import { COGNITO_ENDPOINT, COGNITO_CLIENT_ID } from './constants.js';

async function cognito(target, body) {
    const res = await fetch(COGNITO_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = {}; }
    if (!res.ok) {
        const msg = json.message || json.__type || text.slice(0, 200);
        const err = new Error(`Cognito ${target} failed (${res.status}): ${msg}`);
        err.cognitoType = json.__type || '';
        throw err;
    }
    return json;
}

/**
 * A session that holds the access token and knows how to refresh it.
 *   const session = await login(email, password);
 *   session.token            // current access token (string)
 *   await session.valid()    // token, refreshing if it's near expiry
 */
export async function login(email, password, clientId = COGNITO_CLIENT_ID) {
    if (!email || !password) {
        throw new Error('Courted email and password are required (set input.email / input.password or COURTED_EMAIL / COURTED_PASSWORD).');
    }

    const apply = (auth) => {
        const r = auth.AuthenticationResult || {};
        session.token = r.AccessToken || session.token;
        // ExpiresIn is seconds from now; refresh 5 min early.
        const ttl = (r.ExpiresIn || 3600) * 1000;
        session.expiresAt = Date.now() + ttl - 5 * 60 * 1000;
        if (r.RefreshToken) session.refreshToken = r.RefreshToken;
    };

    const session = {
        email,
        clientId,
        token: '',
        refreshToken: '',
        expiresAt: 0,
        async valid() {
            if (this.token && Date.now() < this.expiresAt) return this.token;
            await this.refresh();
            return this.token;
        },
        async refresh() {
            if (this.refreshToken) {
                try {
                    const auth = await cognito('InitiateAuth', {
                        AuthFlow: 'REFRESH_TOKEN_AUTH',
                        ClientId: this.clientId,
                        AuthParameters: { REFRESH_TOKEN: this.refreshToken },
                    });
                    apply(auth);
                    return;
                } catch {
                    // fall back to a fresh password login
                }
            }
            const auth = await cognito('InitiateAuth', {
                AuthFlow: 'USER_PASSWORD_AUTH',
                ClientId: this.clientId,
                AuthParameters: { USERNAME: email, PASSWORD: password },
            });
            if (auth.ChallengeName) {
                throw new Error(`Cognito returned a challenge "${auth.ChallengeName}" (e.g. MFA / new-password). This account needs interactive sign-in.`);
            }
            apply(auth);
        },
    };

    await session.refresh();
    if (!session.token) throw new Error('Login succeeded but no access token was returned.');
    return session;
}

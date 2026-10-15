import dotenv from 'dotenv';
import type { SignOptions } from 'jsonwebtoken';

dotenv.config({ quiet: true });

// Lee una variable del .env que es obligatoria.
// Si falta, el servidor no arranca y dice cuál es, en lugar de fallar más tarde sin explicación.
const required = (name: string) => {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Falta la variable ${name} en el .env (cópiala de .env.example)`);
    }

    return value;
};

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/seminari7';

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:4200';

const SERVER_PORT = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 1337;

// Secretos con los que se firman los tokens. Son dos distintos para que un refresh token
// no sirva como access token ni al revés.
const JWT_SECRET = required('JWT_SECRET');
const JWT_REFRESH_SECRET = required('JWT_REFRESH_SECRET');

// Cuánto dura cada token, con el formato de la librería ms: '15m', '7d', '2s'...
// El tipo de expiresIn de jsonwebtoken solo acepta ese formato, por eso el "as".
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '15m') as SignOptions['expiresIn'];
const JWT_REFRESH_EXPIRES_IN = (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as SignOptions['expiresIn'];

export const config = {
    mongo: {
        url: MONGO_URL
    },
    server: {
        port: SERVER_PORT
    },
    cors: {
        origin: CORS_ORIGIN
    },
    jwt: {
        secret: JWT_SECRET,
        refreshSecret: JWT_REFRESH_SECRET,
        expiresIn: JWT_EXPIRES_IN,
        refreshExpiresIn: JWT_REFRESH_EXPIRES_IN
    }
};

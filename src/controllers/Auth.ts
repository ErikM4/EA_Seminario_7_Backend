import { NextFunction, Request, Response } from 'express';
import AuthService from '../services/AuthService';

//================================
import { CookieOptions } from 'express';

const REFRESH_COOKIE_OPTIONS: CookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    path: '/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production'
};
//================================

// Función para registrar un usuario nuevo
// Según el contrato, el registro no devuelve token: el frontend lleva al usuario a la página de login
const register = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = await AuthService.register(req.body);

        // 201 porque se ha creado un recurso nuevo
        res.status(201).json({ user });
    } catch (error) {
        // Si el email ya existe, el ErrorHandler responde 409
        next(error);
    }
};

// Función para iniciar sesión
const login = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = await AuthService.login(req.body.email, req.body.password);

        if (result) {
            //================================
            const { token, refreshToken, user } = result;

            res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

            res.status(200).json({ token, user });
            //================================
        } else {
            // 401: no se ha podido identificar al usuario
            res.status(401).json({ message: 'Email o contraseña incorrectos' });
        }
    } catch (error) {
        next(error);
    }
};

// Función para pedir un access token nuevo con el refresh token
const refresh = async (req: Request, res: Response, next: NextFunction) => {
    try {
        //================================
        const refreshToken = req.cookies?.refreshToken;

        if (!refreshToken) {
            return res.status(401).json({ message: 'Refresh token no proporcionado o cookie no encontrada' });
        }

        const result = await AuthService.refresh(refreshToken);
        //================================

        if (result) {
            // Devolvemos { token }
            res.status(200).json(result);
        } else {
            res.status(401).json({ message: 'El usuario ya no existe' });
        }
    } catch (error) {
        // Si el refresh token está caducado o no es válido, el ErrorHandler responde 401
        next(error);
    }
};

//================================
const logout = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.clearCookie('refreshToken', { path: '/auth' });
        res.status(200).json({ message: 'Sesión cerrada correctamente' });
    } catch (error) {
        next(error);
    }
};

export default { register, login, refresh, logout };
//================================

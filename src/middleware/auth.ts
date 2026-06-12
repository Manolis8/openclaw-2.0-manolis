import { Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase.js'

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string
        email: string
      }
    }
  }
}

export async function authenticateUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' })
      return
    }

    const token = authHeader.substring(7)

    const { data, error } = await supabase.auth.getUser(token)

    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }

    req.user = {
      id: data.user.id,
      email: data.user.email || ''
    }

    next()
  } catch (error) {
    console.error('[Auth] Authentication error:', error)
    res.status(500).json({
      error: 'Authentication failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7)

      supabase.auth.getUser(token).then(({ data }) => {
        if (data.user) {
          req.user = {
            id: data.user.id,
            email: data.user.email || ''
          }
        }
        next()
      }).catch(() => {
        next()
      })
    } else {
      next()
    }
  } catch (error) {
    console.error('[Auth] Optional auth error:', error)
    next()
  }
}

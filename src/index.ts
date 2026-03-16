import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { tasksRouter } from './routes/tasks.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

app.use(express.json())

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`)
  next()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date() })
})

app.use('/api', tasksRouter)

app.listen(PORT, () => {
  console.log(`✅ Felo backend running on port ${PORT}`)
})

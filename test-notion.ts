import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from './src/lib/encryption.js'

console.log('ENCRYPTION_KEY:', process.env.ENCRYPTION_KEY ? `${process.env.ENCRYPTION_KEY.slice(0, 10)}...` : 'NOT SET')

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

async function test() {
  // Fetch the actual encrypted token from Supabase
  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('*')
    .eq('user_id', '177794f8-f295-4154-a5ff-1db38eed28b1')
    .eq('provider', 'notion')
    .single()

  if (error || !data) {
    console.error('❌ Token not found in Supabase:', error)
    return
  }

  console.log('✅ Token found in Supabase')
  console.log('Encrypted token:', data.access_token.slice(0, 50) + '...')

  try {
    const decrypted = decrypt(data.access_token)
    console.log('✅ Decrypted successfully!')
    console.log('Token starts with:', decrypted.slice(0, 20))
  } catch (err) {
    console.error('❌ Decryption failed:', err)
  }
}

test()

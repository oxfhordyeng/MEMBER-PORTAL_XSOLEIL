const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl && !serviceRoleKey) {
  module.exports = null;
} else {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to configure Supabase.');
  }

  module.exports = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    }
  });
}
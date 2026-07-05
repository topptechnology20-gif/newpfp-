var express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    io = require('socket.io')(server),
    GameCollection = require('./games.js').GameCollection,
    games = new GameCollection();
const { selectNextQueuedBattle } = require('./queuePolicy');

app.use(function (req, res, next) {
  if (/\.js(\?|$)/.test(req.url)) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (/\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(req.url)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
  next();
});

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
const { Pool } = require('pg');
const { PrivyClient } = require('@privy-io/server-auth');

const privy = new PrivyClient(
  process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID,
  process.env.PRIVY_APP_SECRET || process.env.VITE_PRIVY_APP_SECRET
);

const Pusher = require('pusher');
let pusher = null;
if (process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER) {
  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true
  });
}

const dbClient = new Pool({
  connectionString: process.env.DATABASE_URL
});
dbClient.on('error', err => {
  console.error('Unexpected error on idle db client', err);
});
dbClient.connect().then(async () => {
  // Ensure chat table exists
  try {
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS bota_chat_messages (
        id SERIAL PRIMARY KEY,
        user_name VARCHAR(100),
        wallet_address VARCHAR(100),
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await dbClient.query(`
        CREATE TABLE IF NOT EXISTS bota_notifications (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(100),
          title VARCHAR(100),
          message TEXT,
          type VARCHAR(50),
          icon VARCHAR(10),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      await dbClient.query(`
        CREATE TABLE IF NOT EXISTS bota_arena_battles (
        id SERIAL PRIMARY KEY,
        p1_wallet VARCHAR(100),
        p1_agent VARCHAR(100),
        p2_wallet VARCHAR(100),
        p2_agent VARCHAR(100),
        status VARCHAR(20) DEFAULT 'queued',
        winner VARCHAR(100),
        is_pfp BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
      await dbClient.query(`ALTER TABLE bota_arena_battles ADD COLUMN IF NOT EXISTS is_pfp BOOLEAN DEFAULT false`);
    console.log('Battles table verified.');
  } catch (err) {
    console.error('Failed to create tables:', err);
  }
}).catch(console.error);

const LEGACY_AGENTS = [];

app.use(express.json());

app.get('/api/bantahbro/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    const token = authHeader.split(' ')[1];
    const verifiedClaims = await privy.verifyAuthToken(token);
    const userId = verifiedClaims.userId;

    // Fetch user details
    const userRes = await dbClient.query(`SELECT primary_wallet_address, wallet_addresses FROM users WHERE id = $1`, [userId]);
    const walletAddress = userRes.rows[0] ? userRes.rows[0].primary_wallet_address : null;

    // Fetch balance
    let balance = 0;
    if (walletAddress) {
      const balanceRes = await dbClient.query(`SELECT balance FROM bantcredit_balances WHERE wallet_address = $1`, [walletAddress]);
      balance = balanceRes.rows[0] ? parseFloat(balanceRes.rows[0].balance) : 0;
    }

    // Fetch USDC Earned and BANTC Claim
    let earnedUSDC = 0;
    let bantcClaim = 0;
    const rewardsRes = await dbClient.query(`SELECT share_amount_usdc, bc_snapshot FROM user_rewards_claims WHERE user_id = $1`, [userId]);
    if (rewardsRes.rows.length > 0) {
       earnedUSDC = rewardsRes.rows.reduce((sum, row) => sum + parseFloat(row.share_amount_usdc || 0), 0);
       bantcClaim = rewardsRes.rows.reduce((sum, row) => sum + parseInt(row.bc_snapshot || 0), 0);
    }
    
    // Add legacy profile stats as requested
    earnedUSDC += 1250.00;
    bantcClaim += 1240000;

    // Fetch fighter profiles (assuming wallet_address links them)
    let fightersRes = { rows: [] };
    if (walletAddress) {
      fightersRes = await dbClient.query(
        'SELECT * FROM bota_fighter_profiles WHERE wallet_address = $1 OR agent_id = $1',
        [walletAddress]
      );
    }

    // Fetch Battle History
    let battleHistory = [];
    if (fightersRes.rows.length > 0) {
      // Look for agent_id in the rows, since we don't know the exact schema, we fallback to walletAddress
      const fighterIds = fightersRes.rows.map(f => f.agent_id || f.id).filter(id => id);
      if (fighterIds.length > 0) {
        const placeholders = fighterIds.map((_, i) => `$${i + 1}`).join(',');
        const battleRes = await dbClient.query(`
          SELECT * FROM bota_arena_battle_records 
          WHERE winner_agent_id IN (${placeholders}) OR loser_agent_id IN (${placeholders})
          ORDER BY created_at DESC LIMIT 20
        `, fighterIds);
        battleHistory = battleRes.rows;
      }
    }

    // Fetch Packs
    let packs = [];
    const packRes = await dbClient.query(`SELECT * FROM pack_ownership WHERE owner_user_id = $1`, [userId]);
    packs = packRes.rows;

    // Fetch Runes (Tools)
    let runes = [];
    if (walletAddress) {
      const toolRes = await dbClient.query(`SELECT * FROM bota_tool_inventory WHERE owner_wallet = $1`, [walletAddress]);
      runes = toolRes.rows;
    }

    // Inject Legacy Agents into the user's fighterFeed as requested
    const userLegacyAgents = LEGACY_AGENTS.map(agent => ({
      ...agent,
      wallet_address: walletAddress || agent.wallet_address
    }));

    res.json({
      balance,
      earnedUSDC,
      bantcClaim,
      fighterFeed: { profiles: [...userLegacyAgents, ...fightersRes.rows] },
      queueFeed: { battles: [] },
      liveFeed: { battles: [] },
      battleHistory,
      packs,
      runes
    });
  } catch (error) {
    console.error('Profile API Error:', error);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

app.get('/api/bantahbro/leaderboard', async (req, res) => {
  try {
    const leaderboardRes = await dbClient.query(`
      SELECT agent_id, display_name, avatar_url, wins, losses, fame_score, current_streak, wallet_address, is_pfp 
      FROM bota_fighter_profiles 
      ORDER BY is_pfp DESC, fame_score DESC, wins DESC
      LIMIT 100
    `);
    
    // Mix old version users (mock) and new version users (postgres)
    let combined = [...LEGACY_AGENTS, ...leaderboardRes.rows.map(r => ({ ...r, bc_earned: (r.wins || 0) * 5000 }))];
    
    // Sort by wins DESC
    combined.sort((a, b) => (b.wins || 0) - (a.wins || 0));
    
    // Take top 50
    combined = combined.slice(0, 50);

    res.json({ leaderboard: combined });
  } catch (error) {
    console.error('Leaderboard API Error:', error);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

app.get('/api/bantahbro/global-stats', async (req, res) => {
  try {
    const claimsRes = await dbClient.query('SELECT SUM(CAST(bc_snapshot AS NUMERIC)) as total_bc FROM user_rewards_claims');
    const dbTotalBC = claimsRes.rows[0]?.total_bc ? parseInt(claimsRes.rows[0].total_bc) : 0;
    
    const legacyBCTotal = LEGACY_AGENTS.reduce((sum, a) => sum + (a.bc_earned || 0), 0);
    const globalBC = dbTotalBC + legacyBCTotal;

    const fightersRes = await dbClient.query('SELECT COUNT(*) as live_count FROM bota_fighter_profiles');
    const dbLiveFighters = parseInt(fightersRes.rows[0]?.live_count || 0);
    const globalFighters = dbLiveFighters + LEGACY_AGENTS.length;

    res.json({ globalBC, globalFighters });
  } catch (error) {
    console.error('Global Stats API Error:', error);
    res.status(500).json({ error: 'Failed to load global stats' });
  }
});

// Chat API - GET messages
app.get('/api/bantahbro/chat', async (req, res) => {
  try {
    const chatRes = await dbClient.query('SELECT * FROM bota_chat_messages ORDER BY created_at DESC LIMIT 50');
    // Return in chronological order
    res.json({ messages: chatRes.rows.reverse() });
  } catch (error) {
    console.error('Chat GET Error:', error);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

// Chat API - POST message
app.post('/api/bantahbro/chat', async (req, res) => {
  try {
    const { user_name, wallet_address, message } = req.body;
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }
    
    // Default to BOTA_ guest if no username provided
    const uName = user_name || ('BOTA_' + Math.floor(1000 + Math.random() * 9000));
    
    await dbClient.query(
      'INSERT INTO bota_chat_messages (user_name, wallet_address, message) VALUES ($1, $2, $3)',
      [uName, wallet_address || null, message.trim()]
    );
    
    res.json({ success: true, user_name: uName });
  } catch (error) {
    console.error('Chat POST Error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Battles API - POST (create a new battle)

// POST /api/bantahbro/battles/next
// Auto-start the next queued battle
app.post('/api/bantahbro/battles/next', async (req, res) => {
    try {
        const { rows: queueRows } = await dbClient.query(
            "SELECT * FROM bota_arena_battles WHERE status = 'queued' ORDER BY created_at ASC"
        );

        if (queueRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Queue is empty' });
        }

        const nextBattle = selectNextQueuedBattle(queueRows);
        if (!nextBattle) {
            return res.status(404).json({ success: false, message: 'Queue is empty' });
        }

        // If there are 2 or more live battles, end the oldest one to maintain max 3
        const liveRes = await dbClient.query("SELECT id FROM bota_arena_battles WHERE status = 'live' ORDER BY updated_at ASC");
        if (liveRes.rows.length >= 3) {
            const oldestLiveId = liveRes.rows[0].id;
            await dbClient.query("UPDATE bota_arena_battles SET status = 'ended', updated_at = NOW() WHERE id = $1", [oldestLiveId]);
        }

        // Ensure p2_agent exists
        if (!nextBattle.p2_agent) {
            const availableFighters = ['char04', 'robopepe', 'floatrobo', 'crimsonbot', 'toxicbot', 'voidbot', 'furyman'];
            const randomOpponent = availableFighters[Math.floor(Math.random() * availableFighters.length)];
            nextBattle.p2_agent = randomOpponent;
            
            // Map p1_agent to key if it's a display name (e.g., "Robot V1" -> "char04")
            const displayToKey = {
                'Robot V1': 'char04',
                'Robo Pepe': 'robopepe',
                'Floatrobo': 'floatrobo',
                'Crimsonbot': 'crimsonbot',
                'Toxicbot': 'toxicbot',
                'Voidbot': 'voidbot',
                'Fury Man': 'furyman'
            };
            if (displayToKey[nextBattle.p1_agent]) {
                nextBattle.p1_agent = displayToKey[nextBattle.p1_agent];
            } else {
                 nextBattle.p1_agent = nextBattle.p1_agent.toLowerCase().replace(/\s+/g, '');
            }
            
            // Save the defaulted p2_agent to the db
            await dbClient.query("UPDATE bota_arena_battles SET p1_agent = $1, p2_agent = $2 WHERE id = $3", [nextBattle.p1_agent, nextBattle.p2_agent, nextBattle.id]);
        }

        // If there are 2 or more live battles, end the oldest one to maintain max 3
        const liveRes2 = await dbClient.query("SELECT id FROM bota_arena_battles WHERE status = 'live' ORDER BY updated_at ASC");
        if (liveRes2.rows.length >= 3) {
            const oldestLiveId = liveRes2.rows[0].id;
            await dbClient.query("UPDATE bota_arena_battles SET status = 'ended', updated_at = NOW() WHERE id = $1", [oldestLiveId]);
        }

        // Mark the selected one as live
        await dbClient.query(
            "UPDATE bota_arena_battles SET status = 'live' WHERE id = $1",
            [nextBattle.id]
        );

        // Emit notification
        await dbClient.query(
            "INSERT INTO bota_notifications (title, message, type, icon) VALUES ($1, $2, $3, $4)",
            ['Battle Started', `${nextBattle.p1_agent} vs ${nextBattle.p2_agent}`, 'battle', '⚔️']
        );

        res.json({ success: true, battle: nextBattle });
    } catch (error) {
        console.error("Error auto-starting battle:", error);
        res.status(500).json({ success: false, error: 'Failed to start next battle' });
    }
});

app.post('/api/bantahbro/battles', async (req, res) => {
  try {
    const { p1_agent, p2_agent, p1_wallet, p2_wallet, is_pfp } = req.body;
    if (!p1_agent) return res.status(400).json({ error: 'p1_agent required' });
    const normalizedIsPfp = is_pfp === true || is_pfp === 'true' || is_pfp === 1 || is_pfp === '1';

    // Maintain max 3 live battles
    const liveRes3 = await dbClient.query("SELECT id FROM bota_arena_battles WHERE status = 'live' ORDER BY updated_at ASC");
    if (liveRes3.rows.length >= 3) {
        const oldestLiveId = liveRes3.rows[0].id;
        await dbClient.query("UPDATE bota_arena_battles SET status = 'ended', updated_at = NOW() WHERE id = $1", [oldestLiveId]);
    }

    const result = await dbClient.query(
      `INSERT INTO bota_arena_battles (p1_wallet, p1_agent, p2_wallet, p2_agent, status, is_pfp)
       VALUES ($1, $2, $3, $4, 'live', $5) RETURNING id`,
      [p1_wallet || 'arena.sim', p1_agent, p2_wallet || 'arena.sim', p2_agent || '???', normalizedIsPfp]
    );
    
    await dbClient.query(
      `INSERT INTO bota_notifications (title, message, type, icon) VALUES ($1, $2, $3, $4)`,
      ['Battle Started', `${p1_agent} vs ${p2_agent || '???'}`, 'battle', '??']
    );

    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Battles POST Error:', error);
    res.status(500).json({ error: 'Failed to create battle' });
  }
});

// Battles API - PATCH (update status/winner)
app.patch('/api/bantahbro/battles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, winner } = req.body;
    await dbClient.query(
      `UPDATE bota_arena_battles SET status = $1, winner = $2, updated_at = NOW() WHERE id = $3`,
      [status || 'ended', winner || null, id]
    );
    
    if (status === 'ended' && winner) {
      await dbClient.query(
        `INSERT INTO bota_notifications (title, message, type, icon) VALUES ($1, $2, $3, $4)`,
        ['Match Ended', `${winner} wins`, 'battle', '??']
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Battles PATCH Error:', error);
    res.status(500).json({ error: 'Failed to update battle' });
  }
});

// Battles API - GET
app.get('/api/bantahbro/battles', async (req, res) => {
  try {
    const status = req.query.status;
    let query = 'SELECT * FROM bota_arena_battles';
    let params = [];
    
    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }
    
    if (status === 'queued') {
      query += ' ORDER BY is_pfp DESC, created_at ASC LIMIT 50';
    } else {
      query += ' ORDER BY created_at DESC LIMIT 50';
    }
    
    const battlesRes = await dbClient.query(query, params);
    res.json({ battles: battlesRes.rows });
  } catch (error) {
    console.error('Battles GET Error:', error);
    res.status(500).json({ error: 'Failed to fetch battles' });
  }
});

app.get('/api/bantahbro/notifications', async (req, res) => {
  try {
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const verifiedClaims = await privy.verifyAuthToken(token);
        userId = verifiedClaims.userId;
      } catch (e) { console.error('Privy verify error:', e); }
    }
    
    let notifs = { rows: [] };
    try {
      if (userId) {
        notifs = await dbClient.query(`
          SELECT * FROM bota_notifications 
          WHERE user_id = $1 OR user_id IS NULL 
          ORDER BY created_at DESC 
          LIMIT 20
        `, [userId]);
      } else {
        notifs = await dbClient.query(`
          SELECT * FROM bota_notifications 
          WHERE user_id IS NULL 
          ORDER BY created_at DESC 
          LIMIT 20
        `);
      }
    } catch (e) {
      console.warn("Notifications table might not exist yet.");
    }
    
    res.json({ notifications: notifs.rows });
  } catch (error) {
    console.error('Notifications API Error:', error);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

app.use('/newpfp', express.static(__dirname + '/../game/newpfp'));
app.get('/newpfp*', (req, res) => {
    res.sendFile(require('path').resolve(__dirname, '../game/newpfp/index.html'));
});
app.use(express.static(__dirname + '/../game'));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});

var Responses = {
    SUCCESS: 0,
    GAME_EXISTS: 1,
    GAME_NOT_EXISTS: 2,
    GAME_FULL: 3
  },
  Requests = {
    CREATE_GAME: 'create-game',
    JOIN_GAME: 'join-game'
  };

io.sockets.on('connection', function (socket) {
  socket.on(Requests.CREATE_GAME, function (gameName) {
    if (games.createGame(gameName)) {
      games.getGame(gameName).addPlayer(socket);
      socket.emit('response', Responses.SUCCESS);
    } else {
      socket.emit('response', Responses.GAME_EXISTS);
    }
  });
  socket.on(Requests.JOIN_GAME, function (gameName) {
    var game = games.getGame(gameName);
    if (!game) {
      socket.emit('response', Responses.GAME_NOT_EXISTS);
    } else {
      if (game.addPlayer(socket)) {
        socket.emit('response', Responses.SUCCESS);
      } else {
        socket.emit('response', Responses.GAME_FULL);
      }
    }
  });
});





const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/ping', (req, res) => res.send('OK'));
const ADMIN_PASS = '7777';
const RAKE_PERCENT = 0.03;

let adminRakeBalance = 0;
const rooms = {};
const users = {};

const SUITS = ['♠', '♣', '♥', '♦'];
const RANKS = [
    { name: '6', val: 6 }, { name: '7', val: 7 }, { name: '8', val: 8 },
    { name: '9', val: 9 }, { name: '10', val: 10 }, { name: 'В', val: 10 },
    { name: 'Д', val: 10 }, { name: 'К', val: 10 }, { name: 'Т', val: 11 }
];

function getOrCreateUser(playerId, userName) {
    if (!users[playerId]) {
        users[playerId] = {
            id: playerId,
            name: userName || 'Гравець',
            balance: 1000
        };
    } else if (userName) {
        users[playerId].name = userName;
    }
    return users[playerId];
}

function createDeck() {
    let d = [];
    for (let s of SUITS) {
        for (let r of RANKS) {
            let isJoker = (s === '♠' && r.name === '6');
            d.push({
                suit: s, rank: r.name, val: isJoker ? 11 : r.val,
                isJoker, isRed: (s === '♥' || s === '♦')
            });
        }
    }
    return d.sort(() => Math.random() - 0.5);
}

function calculateScore(hand) {
    if (!hand || hand.length < 3) return 0;
    let jokers = hand.filter(c => c.isJoker);
    let normals = hand.filter(c => !c.isJoker);

    if (jokers.length === 1 && normals.length === 2) {
        let c1 = normals.at(0), c2 = normals.at(1);
        if (c1.rank === c2.rank) return c1.rank === 'Т' ? 33 : 30 + c1.val;
    } else if (normals.length === 3) {
        let c1 = normals.at(0), c2 = normals.at(1), c3 = normals.at(2);
        if (c1.rank === c2.rank && c2.rank === c3.rank) return c1.rank === 'Т' ? 33 : 30 + c1.val;
    }

    let acesCount = normals.filter(c => c.rank === 'Т').length + jokers.length;
    if (acesCount === 2) return Math.max(22, getMaxSuitScore(normals, jokers.length));
    return getMaxSuitScore(normals, jokers.length);
}

function getMaxSuitScore(normals, jokerCount) {
    let bySuit = { '♠': 0, '♣': 0, '♥': 0, '♦': 0 };
    for (let c of normals) bySuit[c.suit] += c.val;
    let maxNormalSuit = Math.max(...Object.values(bySuit));
    return jokerCount > 0 ? maxNormalSuit + 11 : maxNormalSuit;
}

function syncUserBalance(playerId, newBalance) {
    if (users[playerId]) users[playerId].balance = newBalance;
    for (let rId in rooms) {
        let p = rooms[rId].players.find(x => x.id === playerId);
        if (p) p.balance = newBalance;
    }
}

function nextTurn(room) {
    let active = room.players.filter(p => !p.folded);
    if (active.length <= 1) {
        finishRound(room, active.at(0));
        return;
    }
    let loops = 0;
    do {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        loops++;
    } while (room.players.at(room.turnIndex).folded && loops <= room.players.length);
}

function finishRound(room, winnerOverride = null) {
    room.gameActive = false;
    room.reveal = true;
    let active = room.players.filter(p => !p.folded);

    if (winnerOverride) {
        let fee = Math.round(room.pot * RAKE_PERCENT);
        let netWin = room.pot - fee;
        adminRakeBalance += fee;
        winnerOverride.balance += netWin;
        syncUserBalance(winnerOverride.id, winnerOverride.balance);
        room.message = `Переміг ${winnerOverride.name}! Виграш: ${netWin} фішок (рейк 3%: ${fee}).`;
        room.pot = 0;
        room.isSvara = false;
        return;
    }

    let maxScore = Math.max(...active.map(p => calculateScore(p.hand)));
    let winners = active.filter(p => calculateScore(p.hand) === maxScore);

    if (winners.length > 1) {
        room.isSvara = true;
        room.message = `🔥 СВАРА (${maxScore} очок)! Банк ${room.pot} фішок іде далі.`;
    } else {
        let win = winners.at(0);
        let fee = Math.round(room.pot * RAKE_PERCENT);
        let netWin = room.pot - fee;
        adminRakeBalance += fee;
        win.balance += netWin;
        syncUserBalance(win.id, win.balance);
        room.message = `🏆 Переміг ${win.name} (${maxScore} очок)! +${netWin} фішок (рейк 3%: ${fee}).`;
        room.pot = 0;
        room.isSvara = false;
    }
}
app.post('/api/profile', (req, res) => {
    const { playerId, userName } = req.body;
    const u = getOrCreateUser(playerId, userName);
    res.json({ balance: u.balance, adminRake: adminRakeBalance });
});

app.post('/api/join', (req, res) => {
    const { roomId, maxSeats, playerId, userName } = req.body;
    const user = getOrCreateUser(playerId, userName);

    if (!rooms[roomId]) {
        rooms[roomId] = {
            id: roomId,
            maxSeats: Math.min(Math.max(parseInt(maxSeats) || 6, 2), 12),
            players: [],
            pot: 0,
            gameActive: false,
            reveal: false,
            isSvara: false,
            turnIndex: 0,
            message: 'Очікування гравців за столом...'
        };
    }
    const room = rooms[roomId];
    let existing = room.players.find(p => p.id === playerId);
    if (!existing) {
        if (room.players.length >= room.maxSeats) {
            return res.json({ error: 'Стіл вже заповнений!' });
        }
        room.players.push({
            id: playerId,
            name: user.name,
            balance: user.balance,
            hand: [],
            folded: false,
            isDark: true,
            status: 'Готовий'
        });
        room.message = `${user.name} сів за стіл (${room.players.length}/${room.maxSeats}).`;
    } else {
        existing.balance = user.balance;
    }
    res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
    const { roomId, playerId } = req.query;
    const room = rooms[roomId];
    if (!room) return res.json({ error: 'Кімнату не знайдено' });

    const user = getOrCreateUser(playerId);
    const me = room.players.find(p => p.id === playerId) || { balance: user.balance, hand: [], isDark: true, folded: false };
    const safePlayers = room.players.map(other => ({
        id: other.id,
        name: other.name,
        balance: other.balance,
        folded: other.folded,
        status: other.status,
        score: room.reveal ? calculateScore(other.hand) : null,
        hand: (room.reveal && !other.folded) ? other.hand : null
    }));

    const turnPlayer = room.players.at(room.turnIndex);

    res.json({
        roomId: room.id,
        maxSeats: room.maxSeats,
        pot: room.pot,
        isSvara: room.isSvara,
        gameActive: room.gameActive,
        reveal: room.reveal,
        turnId: turnPlayer ? turnPlayer.id : null,
        message: room.message,
        adminRake: adminRakeBalance,
        myData: {
            id: me.id,
            balance: user.balance,
            hand: me.hand,
            isDark: me.isDark,
            folded: me.folded,
            score: (!me.isDark || room.reveal) ? calculateScore(me.hand) : null
        },
        players: safePlayers
    });
});

app.post('/api/action', (req, res) => {
    const { roomId, playerId, action, isDarkBet } = req.body;
    const room = rooms[roomId];
    if (!room) return res.json({ ok: false });

    if (action === 'start') {
        if (room.players.length < 2 || room.gameActive) return res.json({ ok: false });
        let deck = createDeck();
        if (!room.isSvara) room.pot = 0;
        room.players.forEach(p => {
            if (p.balance < 50) return;
            p.balance -= 50;
            syncUserBalance(p.id, p.balance);
            room.pot += 50;
            p.hand = [deck.pop(), deck.pop(), deck.pop()];
            p.folded = false;
            p.isDark = true;
            p.status = 'В темну (50)';
        });
        room.gameActive = true;
        room.reveal = false;
        room.turnIndex = 0;
        room.message = room.isSvara ? '🔥 СВАРА почалася!' : 'Карти роздано!';
    }

    if (action === 'look') {
        const p = room.players.find(x => x.id === playerId);
        if (p && p.isDark && room.gameActive) {
            p.isDark = false;
            p.status = 'В світлу';
        }
    }

    if (action === 'bet' && room.gameActive) {
        const p = room.players.at(room.turnIndex);
        if (p && p.id === playerId) {
            let amount = isDarkBet && p.isDark ? 50 : 100;
            if (p.balance < amount) amount = p.balance;
            p.balance -= amount;
            syncUserBalance(p.id, p.balance);
            room.pot += amount;
            p.status = isDarkBet && p.isDark ? `В темну (+${amount})` : `Ставка (+${amount})`;
            room.message = `${p.name} поставив ${amount} фішок.`;
            nextTurn(room);
        }
    }

    if (action === 'showdown' && room.gameActive) {
        const p = room.players.at(room.turnIndex);
        if (p && p.id === playerId) {
            if (p.balance >= 50) {
                p.balance -= 50;
                syncUserBalance(p.id, p.balance);
                room.pot += 50;
            }
            finishRound(room);
        }
    }

    if (action === 'fold' && room.gameActive) {
        const p = room.players.at(room.turnIndex);
        if (p && p.id === playerId) {
            p.folded = true;
            p.status = 'Впав ❌';
            room.message = `${p.name} скинув карти.`;
            nextTurn(room);
        }
    }

    res.json({ ok: true });
});

app.post('/api/admin/list', (req, res) => {
    if (req.body.pass !== ADMIN_PASS) return res.json({ error: 'Невірний пароль' });
    res.json({ users: Object.values(users), adminRake: adminRakeBalance });
});

app.post('/api/admin/update', (req, res) => {
    const { pass, targetId, delta } = req.body;
    if (pass !== ADMIN_PASS) return res.json({ error: 'Невірний пароль' });
    if (users[targetId]) {
        const newBal = Math.max(0, users[targetId].balance + parseInt(delta || 0));
        syncUserBalance(targetId, newBal);
    }
    res.json({ users: Object.values(users), adminRake: adminRakeBalance });
});

app.post('/api/admin/resetRake', (req, res) => {
    if (req.body.pass !== ADMIN_PASS) return res.json({ error: 'Невірний пароль' });
    adminRakeBalance = 0;
    res.json({ users: Object.values(users), adminRake: adminRakeBalance });
});
app.get('/api/rooms', (req, res) => {
    const list = Object.values(rooms).map(r => ({
        id: r.id,
        count: r.players.length,
        maxSeats: r.maxSeats,
        gameActive: r.gameActive,
        pot: r.pot
    }));
    res.json(list);
});
app.post('/api/leave', (req, res) => {
    const { roomId, playerId } = req.body;
    const room = rooms[roomId];
    if (room) {
        room.players = room.players.filter(p => p.id !== playerId);
        if (room.players.length === 0) {
            delete rooms[roomId];
        } else {
            if (room.turnIndex >= room.players.length) room.turnIndex = 0;
            room.message = 'Один із гравців вийшов зі столу.';
        }
    }
    res.json({ ok: true });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server live on ${PORT}`));

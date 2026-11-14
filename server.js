const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SUITS = ['♠', '♣', '♥', '♦'];
const RANKS = [
    { name: '6', val: 6 }, { name: '7', val: 7 }, { name: '8', val: 8 },
    { name: '9', val: 9 }, { name: '10', val: 10 }, { name: 'В', val: 10 },
    { name: 'Д', val: 10 }, { name: 'К', val: 10 }, { name: 'Т', val: 11 }
];

const RAKE_PERCENT = 0.03;
let adminRakeBalance = 0;
const rooms = {};

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
        if (normals[0].rank === normals[1].rank) return normals[0].rank === 'Т' ? 33 : 30 + normals[0].val;
    } else if (normals.length === 3) {
        if (normals[0].rank === normals[1].rank && normals[1].rank === normals[2].rank) {
            return normals[0].rank === 'Т' ? 33 : 30 + normals[0].val;
        }
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

function nextTurn(room) {
    let active = room.players.filter(p => !p.folded);
    if (active.length <= 1) {
        finishRound(room, active[0]);
        return;
    }
    let loops = 0;
    do {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        loops++;
    } while (room.players[room.turnIndex].folded && loops <= room.players.length);
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
        let win = winners[0];
        let fee = Math.round(room.pot * RAKE_PERCENT);
        let netWin = room.pot - fee;
        adminRakeBalance += fee;
        win.balance += netWin;
        room.message = `🏆 Переміг ${win.name} (${maxScore} очок)! +${netWin} фішок (рейк 3%: ${fee}).`;
        room.pot = 0;
        room.isSvara = false;
    }
}

app.post('/api/join', (req, res) => {
    const { roomId, maxSeats, playerId, userName } = req.body;
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
            name: userName,
            balance: 1000,
            hand: [],
            folded: false,
            isDark: true,
            status: 'Готовий'
        });
        room.message = `${userName} сів за стіл (${room.players.length}/${room.maxSeats}).`;
    }
    res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
    const { roomId, playerId } = req.query;
    const room = rooms[roomId];
    if (!room) return res.json({ error: 'Кімнату не знайдено' });

    const me = room.players.find(p => p.id === playerId) || { balance: 1000, hand: [], isDark: true, folded: false };
    const safePlayers = room.players.map(other => ({
        id: other.id,
        name: other.name,
        balance: other.balance,
        folded: other.folded,
        status: other.status,
        score: room.reveal ? calculateScore(other.hand) : null,
        hand: (room.reveal && !other.folded) ? other.hand : null
    }));

    res.json({
        roomId: room.id,
        maxSeats: room.maxSeats,
        pot: room.pot,
        isSvara: room.isSvara,
        gameActive: room.gameActive,
        reveal: room.reveal,
        turnId: room.players[room.turnIndex]?.id || null,
        message: room.message,
        adminRake: adminRakeBalance,
        myData: {
            id: me.id,
            balance: me.balance,
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
            if (p.balance < 50) p.balance = 1000;
            p.balance -= 50;
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
        const p = room.players[room.turnIndex];
        if (p && p.id === playerId) {
            let amount = isDarkBet && p.isDark ? 50 : 100;
            if (p.balance < amount) amount = p.balance;
            p.balance -= amount;
            room.pot += amount;
            p.status = isDarkBet && p.isDark ? `В темну (+${amount})` : `Ставка (+${amount})`;
            room.message = `${p.name} поставив ${amount} фішок.`;
            nextTurn(room);
        }
    }

    if (action === 'showdown' && room.gameActive) {
        const p = room.players[room.turnIndex];
        if (p && p.id === playerId) {
            if (p.balance >= 50) { p.balance -= 50; room.pot += 50; }
            finishRound(room);
        }
    }

    if (action === 'fold' && room.gameActive) {
        const p = room.players[room.turnIndex];
        if (p && p.id === playerId) {
            p.folded = true;
            p.status = 'Впав ❌';
            room.message = `${p.name} скинув карти.`;
            nextTurn(room);
        }
    }

    res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server live on ${PORT}`));



        

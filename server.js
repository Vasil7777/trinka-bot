const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

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
        if (normals[0].rank === normals[1].rank) {
            return normals[0].rank === 'Т' ? 33 : 30 + normals[0].val;
        }
    } else if (normals.length === 3) {
        if (normals[0].rank === normals[1].rank && normals[1].rank === normals[2].rank) {
            return normals[0].rank === 'Т' ? 33 : 30 + normals[0].val;
        }
    }

    let acesCount = normals.filter(c => c.rank === 'Т').length + jokers.length;
    if (acesCount === 2) {
        return Math.max(22, getMaxSuitScore(normals, jokers.length));
    }
    return getMaxSuitScore(normals, jokers.length);
}

function getMaxSuitScore(normals, jokerCount) {
    let bySuit = { '♠': 0, '♣': 0, '♥': 0, '♦': 0 };
    for (let c of normals) bySuit[c.suit] += c.val;
    let maxNormalSuit = Math.max(...Object.values(bySuit));
    return jokerCount > 0 ? maxNormalSuit + 11 : maxNormalSuit;
}

function broadcastRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.players.forEach(p => {
        const safePlayers = room.players.map(other => ({
            id: other.id,
            name: other.name,
            balance: other.balance,
            folded: other.folded,
            isDark: other.isDark,
            status: other.status,
            score: room.reveal ? calculateScore(other.hand) : null,
            hand: (room.reveal && !other.folded) ? other.hand : null
        }));

        io.to(p.id).emit('stateUpdate', {
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
                id: p.id,
                balance: p.balance,
                hand: p.hand,
                isDark: p.isDark,
                folded: p.folded,
                score: (!p.isDark || room.reveal) ? calculateScore(p.hand) : null
            },
            players: safePlayers
        });
    });
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
        room.message = `Переміг ${winnerOverride.name}! Виграш: ${netWin} фішок (комісія 3%: ${fee}).`;
        room.pot = 0;
        room.isSvara = false;
        broadcastRoom(room.id);
        return;
    }

    let maxScore = Math.max(...active.map(p => calculateScore(p.hand)));
    let winners = active.filter(p => calculateScore(p.hand) === maxScore);

    if (winners.length > 1) {
        room.isSvara = true;
        let names = winners.map(w => w.name).join(', ');
        room.message = `🔥 СВАРА (${maxScore} очок) між: ${names}! Банк ${room.pot} фішок іде далі.`;
    } else {
        let win = winners[0];
        let fee = Math.round(room.pot * RAKE_PERCENT);
        let netWin = room.pot - fee;
        adminRakeBalance += fee;
        win.balance += netWin;
        room.message = `🏆 Переміг ${win.name} (${maxScore} очок)! Виграш: +${netWin} фішок (комісія 3%: ${fee}).`;
        room.pot = 0;
        room.isSvara = false;
    }
    broadcastRoom(room.id);
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, maxSeats, userName }) => {
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
        if (room.players.length >= room.maxSeats) {
            socket.emit('errorMsg', 'Стіл вже заповнений (максимум ' + room.maxSeats + ' чол.)');
            return;
        }

        socket.join(roomId);
        socket.roomId = roomId;

        room.players.push({
            id: socket.id,
            name: userName || 'Гравець_' + socket.id.slice(0, 4),
            balance: 1000,
            hand: [],
            folded: false,
            isDark: true,
            status: 'Готовий'
        });

        room.message = `${userName} сів за стіл (${room.players.length}/${room.maxSeats}).`;
        broadcastRoom(roomId);
    });

    socket.on('startRound', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 2 || room.gameActive) return;

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
        room.message = room.isSvara ? '🔥 СВАРА почалася! Хід першого гравця.' : 'Карти роздано! Ставки в темну або в світлу.';
        broadcastRoom(room.id);
    });

    socket.on('lookCards', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameActive) return;
        const p = room.players.find(x => x.id === socket.id);
        if (p && p.isDark) {
            p.isDark = false;
            p.status = 'В світлу';
            broadcastRoom(room.id);
        }
    });

    socket.on('bet', ({ isDarkBet }) => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameActive) return;
        const p = room.players[room.turnIndex];
        if (!p || p.id !== socket.id) return;

        let amount = isDarkBet && p.isDark ? 50 : 100;
        if (p.balance < amount) amount = p.balance;
        p.balance -= amount;
        room.pot += amount;
        p.status = isDarkBet && p.isDark ? `В темну (+${amount})` : `Ставка (+${amount})`;
        room.message = `${p.name} поставив ${amount} фішок.`;

        nextTurn(room);
        broadcastRoom(room.id);
    });

    socket.on('showdown', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameActive) return;
        const p = room.players[room.turnIndex];
        if (!p || p.id !== socket.id) return;

        if (p.balance >= 50) {
            p.balance -= 50;
            room.pot += 50;
        }
        finishRound(room);
    });

    socket.on('fold', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameActive) return;
        const p = room.players[room.turnIndex];
        if (!p || p.id !== socket.id) return;

        p.folded = true;
        p.status = 'Впав ❌';
        room.message = `${p.name} скинув карти.`;

        nextTurn(room);
        broadcastRoom(room.id);
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
            delete rooms[socket.roomId];
        } else {
            if (room.turnIndex >= room.players.length) room.turnIndex = 0;
            room.message = 'Один із гравців залишив стіл.';
            broadcastRoom(room.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер Тріньки запущено на порту ${PORT}`));

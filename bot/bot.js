const socketClient = require("socket.io-client");
const axios = require("axios");

const connection = socketClient(process.env.DEV ? "http://localhost:1234" : "https://chat-gateway.veld.dev/");
console.log(`starting in ${process.env.DEV ? "dev" : "prod"} mode`);

const members = {};
let currentUser = null;
let token = null;

connection.on('connect', () => {
  console.log("connected to gateway");
  connection.emit("login", { token: null, bot: true })
});

connection.on('ready', (info) => {
  console.log(info);
  token = info.token;
  currentUser = info.user;
  for (let m of info.members) {
    members[m.id] = m;
  }

  connection.emit("channel:message", {
    message: "/nick BOT-miki"
  });
});

connection.on("channel:join", (user) => {
  if (!currentUser) {
    return;
  }

  if (user.id == currentUser.id) {
    return;
  }

  connection.emit('usr-msg', {
    content: "welcome " + user.name + "!"
  });
  members[user.id] = user;
})

connection.on("channel:leave", (user) => {
  connection.emit('usr-msg', {
    content: "bye " + user.name + " :sob:"
  });
  delete members[user.id];
})

connection.on('message:create', async (message) => {
  if (!message.content || message.bot) {
    return;
  }

  if (message.content == "!check") {
    try {
      await axios.post("https://chat-gateway.veld.dev/api/v1/channels/0/messages", {
        channelId: "0",
        embed: {
          title: "Hi I'm Veld's test bot!",
          description: "Thanks for checking me out :)",
          imageUrl: "https://cdn.miki.ai/ext/imgh/12ERnwskpGx.jpeg",
        },
      }, {
        headers: {
          Authorization: "Bearer " + token
        }
      })
    } catch (err) {
      console.log(err.response.data.details);
      return;
    }
  }
  if (message.content.startsWith("!say")) {
    let toSay = message.message.substring(4);
    console.log(toSay);

    connection.emit('usr-msg', {
      content: toSay
    });
  }

  if (message.content == "!help") {
    connection.emit('usr-msg', {
      content: "!help\n!say <message>\n!ping"
    });
  }

  if (message.content.startsWith("!remind")) {
    connection.emit('usr-msg', {
      content: "haha... no. I am too lazy to write this."
    });
  }
});
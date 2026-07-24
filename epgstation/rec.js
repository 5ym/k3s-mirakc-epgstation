function count (str) {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
        (str[i].match(/[ -~]|\n/)) ? len += 1 : len += 2;
    }
    return len;
}

head = "";
switch(process.argv[2]) {
    case 'add':
        head = "Recording has been added.";
        break;
    case 'update':
        head = "Recording has been updated.";
        break;
    case 'delete':
        head = "Recording has been deleted.";
        break;
    case 'failprep':
        head = "Failed to prepare for recording.";
        break;
    case 'fail':
        head = "Failed while recording.";
        break;
    case 'encode':
        head = "Encoding has been completed.";
        break;
}
channel = `Channel:${process.env.HALF_WIDTH_CHANNELNAME}`
title = `Title:${process.env.HALF_WIDTH_NAME}`
description = `Description:${process.env.HALF_WIDTH_DESCRIPTION}`
to = '@5yuim'
text = `${head}\n${title}\n${channel}`
if (count(`${text}\n${description}\n${to}`) < 280) {
    text += `\n${description}`
}
text += `\n${to}`

fetch('http://xool.xool:3000/api/tweets', {
    method: 'POST',
    body: JSON.stringify({
        key: process.env.XOOL_API_KEY,
        text: text,
    })
}).then((data) => data.json()).then((result) => {
    console.log(result)
}).catch((error) => {
    console.error(error)
    process.exit(1)
})

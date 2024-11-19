import express from 'express';
import multer from 'multer';
import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';

var queue = []

var movieFolder = "C:/Movies/"
var saveShow = "C:/Shows/"

const PORT = 3000

const app = express();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, (file.originalname));
    }
});

const upload = multer({ storage: storage });

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}


const client = new WebTorrent();


const log = (message) => {
    const timestamp = new Date().toTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage); // Console LOG even tho we use our own log because we wanna see in the console too

    // Broadcast the new log to all connected WebSocket clients
    broadcastLog(message);
};

app.get("/", (req, res) => {
    res.send(`
    <html>
      <body>
        <h1>Upload a Movie or Show Torrent</h1>
        <form ref="uploadForm" action="/upload" method="post" encType="multipart/form-data">
          <input type="file" name="torrents" multiple/>
          <button type="submit">Upload Torrent</button>
        </form>
        <br>
        <script>
  const ws = new WebSocket('ws://' + window.location.host);

    ws.onmessage = (event) => {
        alert(event.data);
    }
    </script>
      </body>
    </html>
  `);
})

let isProcessing = false; // Flag to indicate if a torrent is being processed
let currentTorrent = null; // Track the currently processing torrent

const processNextTorrent = () => {
    if (queue.length === 0 || isProcessing) return;

    isProcessing = true;
    currentTorrent = queue.shift(); // Set the current torrent
    const { torrentFilePath, res } = currentTorrent;

    client.add(torrentFilePath, (torrent) => {
        log(`Started processing torrent: ${torrent.infoHash}`);

        const episodePattern = /S(\d+)[\s._-]*E?(\d+)/i;
        const isShow = torrent.files.some(file => episodePattern.test(file.name));
        const allowedExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'];

        // Total size of the torrent in bytes
        let totalSizeBytes = torrent.length;
        const totalSizeMB = (totalSizeBytes / (1024 * 1024)).toFixed(2); // Convert to MB

        console.log(`Total size: ${totalSizeMB} MB`);

        // Function to calculate and log the time estimate dynamically
        const updateEstimate = setInterval(() => {
            const downloadSpeedBytes = torrent.downloadSpeed; // Current download/unpacking speed in bytes/second
            const downloadSpeedMBps = (downloadSpeedBytes / (1024 * 1024)).toFixed(2); // Convert to MB/s
            totalSizeBytes -= downloadSpeedBytes * 9.5;
            if (downloadSpeedBytes > 0) {
                const timeRemainingSeconds = (totalSizeBytes / downloadSpeedBytes).toFixed(2);
                console.log(`Current speed: ${downloadSpeedMBps} MB/s, Size remaining: ${(totalSizeBytes / (1024 * 1024)).toFixed(2)} seconds`);
            } else {
            }
        }, 10000); // Update every second

        const shouldSkipFile = (file) => {
            const ext = path.extname(file.name).toLowerCase();
            const isSample = /sample/i.test(file.name);
            const isAllowedVideo = allowedExtensions.includes(ext);
            return isSample || !isAllowedVideo;
        };

        const filePromises = torrent.files
            .filter(file => !shouldSkipFile(file))
            .map(file => {
                return new Promise((resolve, reject) => {
                    let destPath;

                    if (isShow) {
                        const match = file.name.match(/(.+?)[._\-\s]+S(\d+)[\s._-]*E?(\d+)/i);
                        if (!match) {
                            log(`Could not parse show and season from: ${file.name}`);
                            return resolve(); // Skip file processing
                        }

                        const showName = match[1].replace(/[\s._-]+$/, '').trim();
                        const seasonNumber = parseInt(match[2], 10);

                        const showFolder = path.join(saveShow, showName, `Season ${seasonNumber}`);
                        fs.mkdirSync(showFolder, { recursive: true });

                        destPath = path.join(showFolder, path.basename(file.name));
                        log(`Saving as show to: ${destPath}`);
                    } else {
                        fs.mkdirSync(movieFolder, { recursive: true });

                        destPath = path.join(movieFolder, path.basename(file.name));
                        log(`Saving as movie to: ${destPath}`);
                    }

                    const sourceStream = file.createReadStream();
                    const writeStream = fs.createWriteStream(destPath);

                    sourceStream.pipe(writeStream);

                    writeStream.on('finish', () => {
                        log(`File saved to: ${destPath}`);
                        resolve();
                    });

                    writeStream.on('error', (err) => {
                        log(`Error saving file: ${err}`);
                        reject(err);
                    });
                });
            });

        Promise.all(filePromises)
            .then(() => {
                log(`Finished processing torrent: ${torrent.infoHash}`);
                isProcessing = false;
                currentTorrent = null;
                processNextTorrent();
            })
            .catch((err) => {
                log(`Error processing torrent: ${err}`);
                res.status(500).send('An error occurred while processing the torrent.');
                isProcessing = false;
                currentTorrent = null;
                processNextTorrent();
            });
    }).on('error', (err) => {
        log(`Error adding torrent: ${err.message}`);
        res.status(400).send('Invalid torrent file. Please check the file and try again.');
        isProcessing = false;
        currentTorrent = null;
        processNextTorrent();
    });
};

app.post('/upload', upload.array('torrents'), (req, res) => {
    console.log('Received POST request at /upload');
    if (!req.files || req.files.length === 0) {
        log('No files were uploaded.');
        return res.status(400).send('No files were uploaded.');
    }

    log(`Received ${req.files.length} torrent files.`);

    req.files.forEach((file) => {
        const torrentFilePath = file.path;
        log(`Added file to queue: ${file.originalname} (${torrentFilePath})`);
        queue.push({ torrentFilePath, res });
    });

    processNextTorrent();

    res.send('All torrents have been added to the processing queue!');
});






const server = app.listen(PORT, () => {
    log(`Server running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

const broadcastLog = (message) => {
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // 1 = WebSocket.OPEN
            client.send(message);
        }
    });
};
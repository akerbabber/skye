// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Canonical fixtures for sealed-check. These are contracts WE deploy onto the
 * throwaway fork — see the README. Nothing here is a real mainnet token.
 *
 * The point of the honeypot fixture is that it is indistinguishable from the
 * clean one by metadata alone: same interface, same decimals, and its `name`
 * is under attacker control. Only execution tells them apart.
 */

/// Minimal ERC-20. `name` is attacker-controlled by construction.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint256 _supply) {
        name = _name;
        symbol = _symbol;
        totalSupply = _supply;
        balanceOf[msg.sender] = _supply;
        emit Transfer(address(0), msg.sender, _supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external virtual returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal virtual {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    /// Test helper: mint to an arbitrary address so the fork can seed balances.
    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}

/**
 * A honeypot. Buying works. Selling does not, unless you are the owner.
 * This is the canonical shape of the scam: the token looks and behaves
 * normally right up to the moment you try to get your money back.
 */
contract HoneypotToken is TestToken {
    address public immutable owner;
    address public pair;

    constructor(string memory _name, string memory _symbol, uint256 _supply)
        TestToken(_name, _symbol, _supply)
    {
        owner = msg.sender;
    }

    function setPair(address _pair) external {
        require(msg.sender == owner, "owner");
        pair = _pair;
    }

    function _transfer(address from, address to, uint256 value) internal override {
        // Selling means sending tokens back into the pool. Only the owner may.
        require(to != pair || from == owner, "TRANSFER_LIMITED");
        super._transfer(from, to, value);
    }
}

/**
 * A token that does not block the sell, it just skims it. Used to prove the
 * `returned_less` / transferTaxBps path is measured empirically rather than
 * read off any declared "tax" field.
 */
contract TaxedToken is TestToken {
    address public immutable owner;
    address public pair;
    uint256 public immutable taxBps;

    constructor(string memory _name, string memory _symbol, uint256 _supply, uint256 _taxBps)
        TestToken(_name, _symbol, _supply)
    {
        owner = msg.sender;
        taxBps = _taxBps;
    }

    function setPair(address _pair) external {
        require(msg.sender == owner, "owner");
        pair = _pair;
    }

    function _transfer(address from, address to, uint256 value) internal override {
        if (to == pair && from != owner) {
            uint256 tax = (value * taxBps) / 10000;
            super._transfer(from, address(this), tax);
            super._transfer(from, to, value - tax);
        } else {
            super._transfer(from, to, value);
        }
    }
}

/**
 * A constant-product pool, deliberately tiny. Enough to buy a token with ETH
 * and sell it back, which is all the honeypot check needs. Not a real AMM.
 */
contract MiniPool {
    TestToken public immutable token;
    uint256 public reserveToken;
    uint256 public reserveEth;

    constructor(TestToken _token) payable {
        token = _token;
        reserveEth = msg.value;
    }

    /// Called once after the pool is funded with tokens.
    function sync() external {
        reserveToken = token.balanceOf(address(this));
        reserveEth = address(this).balance;
    }

    /// Buy tokens with ETH.
    function buy(uint256 minOut) external payable returns (uint256 out) {
        require(msg.value > 0, "no eth");
        out = (reserveToken * msg.value) / (reserveEth + msg.value);
        require(out >= minOut, "slippage");
        reserveEth += msg.value;
        reserveToken -= out;
        require(token.transfer(msg.sender, out), "transfer failed");
    }

    /// Sell tokens back for ETH. Pulls via transferFrom, so a honeypot's
    /// transfer restriction makes this revert — which is exactly the finding.
    function sell(uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        uint256 before = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), amountIn), "transferFrom failed");
        // Measure what actually arrived, not what was requested. A taxing token
        // delivers less; that difference is the empirical tax.
        uint256 received = token.balanceOf(address(this)) - before;
        out = (reserveEth * received) / (reserveToken + received);
        require(out >= minOut, "slippage");
        reserveToken += received;
        reserveEth -= out;
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "eth send failed");
    }

    receive() external payable {}
}

/// A perfectly ordinary spender, deployed early on the fork so it reads as aged.
contract BoringRouter {
    function pull(TestToken token, address from, uint256 amount) external {
        require(token.transferFrom(from, address(this), amount), "transferFrom failed");
    }
}

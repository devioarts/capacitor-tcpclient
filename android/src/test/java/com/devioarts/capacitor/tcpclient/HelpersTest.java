package com.devioarts.capacitor.tcpclient;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import com.getcapacitor.JSArray;
import org.json.JSONObject;
import org.junit.Test;

public class HelpersTest {

    @Test
    public void hexToBytesAcceptsCommonSpellings() {
        assertArrayEquals(new byte[] { 0x1b, 0x40 }, Helpers.INSTANCE.hexToBytes("1b40"));
        assertArrayEquals(new byte[] { 0x1b, 0x40 }, Helpers.INSTANCE.hexToBytes("0x1b 0x40"));
        assertArrayEquals(new byte[] { 0x1b, 0x40 }, Helpers.INSTANCE.hexToBytes("1B 40"));
    }

    @Test
    public void hexToBytesRejectsEmptyOddAndInvalidHex() {
        assertNull(Helpers.INSTANCE.hexToBytes(""));
        assertNull(Helpers.INSTANCE.hexToBytes("abc"));
        assertNull(Helpers.INSTANCE.hexToBytes("zz"));
    }

    @Test
    public void jsArrayToBytesRejectsInvalidByteValues() throws Exception {
        assertArrayEquals(new byte[] { 0, 127, -1 }, Helpers.INSTANCE.jsArrayToBytes(new JSArray(new int[] { 0, 127, 255 })));
        assertNull(Helpers.INSTANCE.jsArrayToBytes(new JSArray(new int[] { -1 })));
        assertNull(Helpers.INSTANCE.jsArrayToBytes(new JSArray(new int[] { 256 })));
    }

    @Test
    public void jsonObjectToBytesRejectsHugeDeclaredLengthBeforeAllocation() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("length", 20 * 1024 * 1024);

        assertNull(Helpers.INSTANCE.jsonObjectToBytes(obj));
    }

    @Test
    public void indexOfRangeFindsPatternInsideUsedPrefixOnly() {
        byte[] haystack = new byte[] { 1, 2, 3, 4, 5, 6 };

        assertEquals(2, Helpers.INSTANCE.indexOfRange(haystack, 5, new byte[] { 3, 4 }));
        assertEquals(-1, Helpers.INSTANCE.indexOfRange(haystack, 3, new byte[] { 4, 5 }));
        assertEquals(-1, Helpers.INSTANCE.indexOfRange(haystack, haystack.length, new byte[] {}));
    }
}
